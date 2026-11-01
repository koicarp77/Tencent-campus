export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
// Keep timeouts separate from confirmed HTTP failures: saving must still
// reconcile with the server when a response is lost.
export class RequestTimeoutError extends Error {
  name = "RequestTimeoutError";
}
export const UPLOAD_REQUEST_POLICY = {
  timeoutMs: 120_000,
  timeoutMessage:
    "上传等待超过2分钟，请刷新页面确认图片是否已上传，再决定是否重试。",
};
export async function request<T>(
  url: string,
  options: RequestInit = {},
  policy: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    policy.timeoutMs ?? 12_000,
  );
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok)
      throw new HttpError(response.status, body.message || "请求失败");
    return body;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError(
        policy.timeoutMessage ?? "请求超时，请检查服务是否正常运行。",
      );
    }
    if (error instanceof TypeError) {
      throw new Error(
        "无法连接服务，请检查启动窗口是否仍在运行，以及网络连接是否正常。",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
