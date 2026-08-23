/**
 * Assembly. The only file that knows every service exists.
 *
 * `services` is created empty and filled in, so each module can hold the whole
 * record from construction and reach for a sibling at call time. That is what
 * makes the cycle between syncing, draining and sending expressible without
 * anything being defined in a particular order.
 */
import { MailHolder, Services } from './contracts';
import { createContacts } from './contacts';
import { createDrafts } from './drafts';
import { createIdentityService } from './identity';
import { createMailbox } from './mailbox';
import { createPublish } from './publish';
import { createScheduler } from './scheduler';
import { createSend } from './send';
import { createSession } from './session';
import { Store } from './store';

export function createServices(store: Store): { services: Services; mail: MailHolder } {
  const mail: MailHolder = { current: null };
  const services = {} as Services;
  const ctx = { store, mail, services };

  services.session = createSession(ctx);
  services.mailbox = createMailbox(ctx);
  services.contacts = createContacts(ctx);
  services.identity = createIdentityService(ctx);
  services.publish = createPublish(ctx);
  services.send = createSend(ctx);
  services.scheduler = createScheduler(ctx);
  services.drafts = createDrafts(ctx);

  return { services, mail };
}
