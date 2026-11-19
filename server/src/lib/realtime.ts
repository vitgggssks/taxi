/**
 * Realtime hub (WebSocket). Channel model:
 *   user:<userId>   – personal stream (offers, order updates, notifications)
 *   order:<orderId> – shared stream for passenger + assigned driver + dispatch
 * Survives reconnects: clients resync with GET /api/orders/:id after reconnect.
 */
import type { WebSocket } from 'ws';

type Channel = string;

class Hub {
  private channels = new Map<Channel, Set<WebSocket>>();
  private sockets = new Map<WebSocket, Set<Channel>>();

  join(ws: WebSocket, channels: Channel[]) {
    for (const ch of channels) {
      if (!this.channels.has(ch)) this.channels.set(ch, new Set());
      this.channels.get(ch)!.add(ws);
      if (!this.sockets.has(ws)) this.sockets.set(ws, new Set());
      this.sockets.get(ws)!.add(ch);
    }
  }

  leaveChannel(ws: WebSocket, channel: Channel) {
    this.channels.get(channel)?.delete(ws);
    this.sockets.get(ws)?.delete(channel);
  }

  leave(ws: WebSocket) {
    for (const ch of this.sockets.get(ws) ?? []) this.channels.get(ch)?.delete(ws);
    this.sockets.delete(ws);
  }

  publish(channels: Channel[], event: string, payload: unknown) {
    const msg = JSON.stringify({ event, payload, at: new Date().toISOString() });
    for (const ch of channels) {
      for (const ws of [...(this.channels.get(ch) ?? [])]) {
        if (ws.readyState !== 1) continue;
        try {
          ws.send(msg);
        } catch {
          // обірваний сокет не має валити бізнес-операцію, що його сповіщає
          this.leave(ws);
        }
      }
    }
  }

  toUser(userId: string, event: string, payload: unknown) {
    this.publish([`user:${userId}`], event, payload);
  }

  toOrder(orderId: string, event: string, payload: unknown) {
    this.publish([`order:${orderId}`], event, payload);
  }

  onlineCount(): number {
    return this.sockets.size;
  }
}

export const hub = new Hub();
