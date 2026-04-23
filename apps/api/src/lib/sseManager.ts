/**
 * SSEManager — manages active Server-Sent Event connections.
 *
 * Connections are keyed by staffId. Each staff member may have multiple
 * concurrent connections (e.g. multiple browser tabs).
 *
 * broadcast() filters connections by branchId + role before pushing.
 * pushToStaff() sends directly to a specific staff member's connections.
 */
import type { Response } from 'express';

export interface NotificationPayload {
  id: number;
  eventType: string;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  createdAt: string;
}

interface ConnectionMeta {
  res: Response;
  branchId: number;
  role: string;
}

class SSEManager {
  // staffId → Set of active connections with metadata
  private connections = new Map<number, Set<ConnectionMeta>>();

  /**
   * Register a new SSE connection for a staff member.
   * Sets the required SSE headers and auto-removes on disconnect.
   */
  register(staffId: number, branchId: number, role: string, res: Response): void {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    res.flushHeaders();

    const meta: ConnectionMeta = { res, branchId, role };

    if (!this.connections.has(staffId)) {
      this.connections.set(staffId, new Set());
    }
    this.connections.get(staffId)!.add(meta);

    // Auto-remove on client disconnect
    res.on('close', () => {
      const conns = this.connections.get(staffId);
      if (conns) {
        conns.delete(meta);
        if (conns.size === 0) {
          this.connections.delete(staffId);
        }
      }
    });
  }

  /**
   * Broadcast a notification to all staff whose role is in targetRoles
   * and whose branchId matches (or branchId is null = system-wide).
   */
  broadcast(branchId: number | null, targetRoles: string[], notification: NotificationPayload): void {
    const data = JSON.stringify(notification);
    for (const [, conns] of this.connections) {
      for (const meta of conns) {
        const roleMatch = targetRoles.includes(meta.role);
        const branchMatch = branchId === null || meta.branchId === branchId;
        if (roleMatch && branchMatch) {
          this.writeEvent(meta.res, 'notification', data);
        }
      }
    }
  }

  /**
   * Push a notification directly to a specific staff member's connections.
   */
  pushToStaff(staffId: number, notification: NotificationPayload): void {
    const conns = this.connections.get(staffId);
    if (!conns) return;
    const data = JSON.stringify(notification);
    for (const meta of conns) {
      this.writeEvent(meta.res, 'notification', data);
    }
  }

  /**
   * Send a ping heartbeat to all active connections.
   * Called every 30s to keep connections alive through proxies.
   */
  ping(): void {
    const data = JSON.stringify({ ts: Date.now() });
    for (const [, conns] of this.connections) {
      for (const meta of conns) {
        this.writeEvent(meta.res, 'ping', data);
      }
    }
  }

  /**
   * Total number of active SSE connections (for health/metrics).
   */
  getConnectionCount(): number {
    let count = 0;
    for (const conns of this.connections.values()) {
      count += conns.size;
    }
    return count;
  }

  private writeEvent(res: Response, event: string, data: string): void {
    try {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      // Connection already closed — ignore
    }
  }
}

// Singleton instance shared across the process
export const sseManager = new SSEManager();
