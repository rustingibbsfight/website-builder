import { eveChannel } from 'eve/channels/eve';
import { localDev, placeholderAuth, vercelOidc } from 'eve/channels/auth';

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // This placeholder will not allow browser requests in production.
    // Replace with a real auth provider if the HTTP channel should be exposed.
    placeholderAuth(),
  ],
});
