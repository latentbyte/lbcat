// 带错误码的浏览器控制错误，原生消息桥原样返回 code 供 CLI 判断
export class BrowserControlError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "BrowserControlError";
  }
}
