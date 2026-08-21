export async function handleScheduled(
  controller: ScheduledController,
  _env: Env,
): Promise<void> {
  console.log(
    JSON.stringify({
      event: "scheduled",
      cron: controller.cron,
      at: controller.scheduledTime,
    }),
  );
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  _env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    console.log(JSON.stringify({ event: "queue_message", id: message.id }));
    message.ack();
  }
}
