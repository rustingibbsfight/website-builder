export interface EveConfig {
  /** Base URL of the wb REST API (a `wb dev` deployment), e.g. https://wb.internal.example */
  wbApiUrl: string;
  slackBotToken: string;
  slackSigningSecret: string;
  /** Claude model for the agent loop. */
  model: string;
  /** Deploy adapter Eve may trigger via deploy_site (static|vercel|netlify|cloudflare). */
  deployAdapter?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EveConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  return {
    wbApiUrl: required('WB_API_URL').replace(/\/$/, ''),
    slackBotToken: required('SLACK_BOT_TOKEN'),
    slackSigningSecret: required('SLACK_SIGNING_SECRET'),
    model: env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
    ...(env.WB_DEPLOY_ADAPTER ? { deployAdapter: env.WB_DEPLOY_ADAPTER } : {}),
  };
}
