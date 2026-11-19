const CLICKUP_API = 'https://api.clickup.com/api/v2';

export type ClickupFieldValue = string | number | boolean;

/** The four ClickUp calls the worker needs. Mocked in tests. */
export interface ClickupClient {
  /** A task in the list whose custom field equals `value`: the guard against a second card. */
  findTaskByField(listId: string, fieldId: string, value: string): Promise<string | null>;
  createTask(listId: string, task: {
    name: string;
    status: string;
    customFields: Array<{ id: string; value: ClickupFieldValue }>;
  }): Promise<string>;
  updateTask(taskId: string, change: { name?: string; status?: string }): Promise<void>;
  setField(taskId: string, fieldId: string, value: ClickupFieldValue): Promise<void>;
  addComment(taskId: string, text: string): Promise<void>;
}

export class ClickupHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`ClickUp returned ${status}${detail ? `: ${detail.slice(0, 140)}` : ''}`);
  }
}

export function httpClickupClient(token: string, fetchImpl: typeof fetch = fetch): ClickupClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${CLICKUP_API}${path}`, {
      method,
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'HolisticHealthHub/1.0',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new ClickupHttpError(response.status, await response.text().catch(() => ''));
    }
    return await response.json().catch(() => ({})) as T;
  }

  return {
    async findTaskByField(listId, fieldId, value) {
      const filter = encodeURIComponent(JSON.stringify([{ field_id: fieldId, operator: '=', value }]));
      const found = await call<{ tasks?: Array<{ id: string }> }>(
        'GET',
        `/list/${encodeURIComponent(listId)}/task?include_closed=true&custom_fields=${filter}`,
      );
      return found.tasks?.[0]?.id ?? null;
    },
    async createTask(listId, task) {
      const created = await call<{ id?: string }>('POST', `/list/${encodeURIComponent(listId)}/task`, {
        name: task.name,
        status: task.status,
        custom_fields: task.customFields,
      });
      if (!created.id) throw new Error('ClickUp created a task without returning its id.');
      return created.id;
    },
    async updateTask(taskId, change) {
      await call('PUT', `/task/${encodeURIComponent(taskId)}`, change);
    },
    async setField(taskId, fieldId, value) {
      await call('POST', `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`, { value });
    },
    async addComment(taskId, text) {
      await call('POST', `/task/${encodeURIComponent(taskId)}/comment`, { comment_text: text, notify_all: false });
    },
  };
}
