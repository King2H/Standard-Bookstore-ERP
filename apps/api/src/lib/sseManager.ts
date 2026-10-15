/**
 * SSEManager — manages active Server-Sent Event connections.
 *
 * Connections are keyed by staffId. Each staff member may have multiple
 * concurrent connections (e.g. multiple browser tabs).
 *
 * broadcast() pushes to the connections that may see the notification, by
 * the rule the notification list applies (notifications.repository.ts): the
 * same tenant, any role held among the target roles, and the notification's
 * branch, a system-wide one, or every branch for staff with access to all.
 * pushToStaff() sends directly to a specific staff member's connections.
 */
import type { Response } from 'express';

export interface NotificationPayload {
  /** A bigint, sent as a string (as the REST list sends it). */
  id: string;
  eventType: string;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  createdAt: string;
}

/** Who a connection belongs to, fixed when it opens. */
export interface Listener {
  tenantId: number;
  /** The session branch. */
  branchId: number;
  /** Every role held in the session branch. */
  roles: string[];
  /** Access to all branches (staff.is_all_branches). */
  allBranches: boolean;
}

interface ConnectionMeta extends Listener {
  res: Response;
}

class SSEManager {
  // staffId → Set of active connections with metadata
  private connections = new Map<number, Set<ConnectionMeta>>();

  /**
   * Register a new SSE connection for a staff member.
   * Sets the required SSE headers and auto-removes on disconnect.
   */
  register(staffId: number, listener: Listener, res: Response): void {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    res.flushHeaders();

    const meta: ConnectionMeta = { ...listener, res };

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
   * Broadcast a tenant's notification to its staff holding one of targetRoles,
   * in its branch (null = system-wide; every branch with access to all).
   */
  broadcast(tenantId: number, branchId: number | null, targetRoles: string[], notification: NotificationPayload): void {
    const data = JSON.stringify(notification);
    for (const [, conns] of this.connections) {
      for (const meta of conns) {
        const tenantMatch = meta.tenantId === tenantId;
        const roleMatch = meta.roles.some((r) => targetRoles.includes(r));
        const branchMatch = branchId === null || meta.allBranches || meta.branchId === branchId;
        if (tenantMatch && roleMatch && branchMatch) {
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
