import type { WebhookDispatcher, WebhookEvent } from "./dispatcher.js";

export async function dispatchWebhookSafely(input: {
  webhooks: Pick<WebhookDispatcher, "dispatch"> | undefined;
  event: WebhookEvent;
  onError: ((error: unknown) => void) | undefined;
}): Promise<void> {
  if (!input.webhooks) return;

  try {
    await input.webhooks.dispatch(input.event);
  } catch (error) {
    input.onError?.(error);
  }
}
