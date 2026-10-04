// Which PayPal and which agents this process runs with, decided once from the environment.
import { claudeBrain, claudePlanBrain, scriptedBrain, type Brain } from "./brain.ts";
import { fakePayPal } from "./fakepaypal.ts";
import { sandboxPayPal, type Creds, type PayPal, type SandboxPayPal } from "./paypal.ts";
import { BUSINESSES } from "./seed.ts";

export function loadConfig(env = process.env) {
  const creds: Record<string, Creds> = {};
  const emails: Record<string, string> = {};
  for (const b of BUSINESSES) {
    const key = b.id.toUpperCase();
    const [clientId, secret, email] = [env[`PAYPAL_${key}_CLIENT_ID`], env[`PAYPAL_${key}_SECRET`], env[`PAYPAL_${key}_EMAIL`]];
    if (clientId && secret && email) {
      creds[b.id] = { clientId, secret };
      emails[b.id] = email;
    }
  }
  // All six or none: a half-configured sandbox would mix real and pretend invoices.
  const live = Object.keys(creds).length === BUSINESSES.length;
  const sandbox: SandboxPayPal | null = live ? sandboxPayPal(creds) : null;
  const paypal: PayPal = sandbox ?? fakePayPal();
  // An API key wins. OFFSET_AGENTS=claude-plan uses the Claude subscription signed in on this machine instead.
  const brain: Brain = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? claudeBrain()
    : env.OFFSET_AGENTS === "claude-plan" ? claudePlanBrain() : scriptedBrain();
  return { paypal, sandbox, brain, emails, creds, publicUrl: (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL)?.replace(/\/$/, "") ?? null, port: Number(env.PORT ?? 8787) };
}
