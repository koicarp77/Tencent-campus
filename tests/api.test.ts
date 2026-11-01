import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  request,
  RequestTimeoutError,
  UPLOAD_REQUEST_POLICY,
} from "../apps/web/src/api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function pendingUntilAbort() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    ),
  );
}
describe("上传与普通请求的超时边界", () => {
  it("普通请求12秒超时转换为中文错误，仍与HTTP错误区分以触发保存核对", async () => {
    vi.useFakeTimers();
    pendingUntilAbort();
    const result = request("/api/images");
    const assertion = expect(result).rejects.toMatchObject({
      name: "RequestTimeoutError",
      message: "请求超时，请检查服务是否正常运行。",
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(new RequestTimeoutError("超时")).not.toBeInstanceOf(HttpError);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("PNG上传响应13秒才到达时仍成功，不被普通12秒阈值中止", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(new Response(JSON.stringify({ image: { id: "png" } }))),
            13_000,
          ),
        );
      }),
    );
    const result = request(
      "/api/images",
      { method: "POST", body: new FormData() },
      UPLOAD_REQUEST_POLICY,
    );
    await vi.advanceTimersByTimeAsync(12_000);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ image: { id: "png" } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("上传超过2分钟提示先确认是否已入库，不直接显示浏览器Abort错误", async () => {
    vi.useFakeTimers();
    pendingUntilAbort();
    const result = request(
      "/api/images",
      { method: "POST" },
      UPLOAD_REQUEST_POLICY,
    );
    const assertion = expect(result).rejects.toThrow(
      "上传等待超过2分钟，请刷新页面确认图片是否已上传，再决定是否重试。",
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });
  it("真实业务错误继续显示后端原因，网络断开转换为可操作的中文提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "暂不支持动画或多帧图片" }), {
            status: 415,
          }),
        ),
    );
    await expect(request("/api/images")).rejects.toMatchObject({
      status: 415,
      message: "暂不支持动画或多帧图片",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(request("/api/images")).rejects.toThrow("无法连接服务");
  });
});
