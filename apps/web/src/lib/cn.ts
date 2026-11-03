import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn-vue 约定的 className 合并函数（clsx + tailwind-merge）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
