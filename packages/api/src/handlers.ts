import { runHousekeeping } from "./jobs/housekeeping";
import { handleQueue as handleEmailQueue } from "./queue/email-consumer";

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  await runHousekeeping(env);
}

export { handleEmailQueue as handleQueue };
