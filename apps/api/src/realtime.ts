import type { Request, Response } from "express";
import type { Db } from "./database.js";
import { requireMember, sessionUser } from "./collaboration.js";
import { fail } from "./service.js";

export type ChangeEvent = {
  type: "review" | "images" | "group-deleted";
  imageId?: string;
  revision?: number;
};
type Client = {
  request: Request;
  response: Response;
  groupId: string;
  userId: string;
  close: () => void;
};
/** Notifications are hints: clients fetch current state after every (re)connect. */
export function createRealtime(db: Db, heartbeatMs = 15_000) {
  const clients = new Set<Client>();
  function authenticated(client: Client) {
    try {
      return sessionUser(db, client.request)?.id === client.userId;
    } catch {
      return false;
    }
  }
  function allowed(client: Client) {
    if (!authenticated(client)) return false;
    try {
      requireMember(db, client.groupId, client.userId);
      return true;
    } catch {
      return false;
    }
  }
  function write(client: Client, event: string, data: unknown) {
    if (
      !clients.has(client) ||
      client.response.destroyed ||
      client.response.writableEnded
    )
      return false;
    // Never queue an unbounded stream for a disconnected/slow consumer. A new
    // EventSource connection gets ready and fetches the latest database state.
    try {
      if (
        !client.response.write(
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
      ) {
        client.close();
        return false;
      }
      return true;
    } catch {
      client.close();
      return false;
    }
  }
  function deny(client: Client) {
    write(client, "access-lost", {
      message: "登录或群组权限已变化，请刷新页面",
    });
    client.close();
  }
  function revalidate() {
    for (const client of clients) if (!allowed(client)) deny(client);
  }
  function publish(groupId: string, event: ChangeEvent) {
    for (const client of clients) {
      if (client.groupId !== groupId) continue;
      if (!allowed(client)) deny(client);
      else write(client, "change", event);
    }
  }
  function afterGroupDeletion(groupId: string) {
    // Capture authorized recipients before the delete transaction removes membership.
    const recipients = [...clients].filter(
      (c) => c.groupId === groupId && allowed(c),
    );
    return () => {
      for (const client of recipients) {
        if (!authenticated(client)) deny(client);
        else {
          write(client, "change", { type: "group-deleted" });
          client.close();
        }
      }
    };
  }
  function connect(
    request: Request,
    response: Response,
    groupId: string,
    userId: string,
  ) {
    requireMember(db, groupId, userId);
    if (request.query.owner !== userId)
      fail(412, "ACCOUNT_CHANGED", "当前登录账号已变化，请刷新页面后继续");
    response.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const client: Client = { request, response, groupId, userId, close };
    let timer: ReturnType<typeof setInterval> | undefined;
    function close() {
      clients.delete(client);
      if (timer) clearInterval(timer);
      request.off("aborted", close);
      response.off("close", close);
      response.off("error", close);
      if (!response.writableEnded) response.end();
    }
    clients.add(client);
    request.on("aborted", close);
    response.on("close", close);
    response.on("error", close);
    response.write("retry: 2000\n\n");
    if (!write(client, "ready", { groupId })) return;
    timer = setInterval(() => {
      if (!allowed(client)) deny(client);
      else {
        try {
          if (!response.write(": heartbeat\n\n")) close();
        } catch {
          close();
        }
      }
    }, heartbeatMs);
    timer.unref();
  }
  return {
    connect,
    publish,
    revalidate,
    afterGroupDeletion,
    closeAll() {
      for (const client of clients) client.close();
    },
    get size() {
      return clients.size;
    },
  };
}
