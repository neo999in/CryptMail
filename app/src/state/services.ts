/**
 * Assembly. The only file that knows every service exists.
 *
 * `services` is created empty and filled in, so each module can hold the whole
 * record from construction and reach for a sibling at call time. That is what
 * makes the cycle between syncing, draining and sending expressible without
 * anything being defined in a particular order.
 */
import { createAccounts } from './accounts';
import { MailHolder, Services } from './contracts';
import { createContacts } from './contacts';
import { createDrafts } from './drafts';
import { createBb84 } from './bb84';
import { createKm } from './km';
import { createIdentityService } from './identity';
import { createLabels } from './labels';
import { createMailbox } from './mailbox';
import { createNotify } from './notify';
import { createPublish } from './publish';
import { createRules } from './rules';
import { createScheduler } from './scheduler';
import { createSend } from './send';
import { createSession } from './session';
import { createSnooze } from './snooze';
import { Store } from './store';
import { osNotifier } from '../notifications/os';

export function createServices(store: Store): { services: Services; mail: MailHolder } {
  const mail: MailHolder = { current: null, clients: new Map() };
  const services = {} as Services;
  const ctx = { store, mail, services };

  services.accounts = createAccounts(ctx);
  services.session = createSession(ctx);
  services.mailbox = createMailbox(ctx);
  services.contacts = createContacts(ctx);
  services.identity = createIdentityService(ctx);
  services.publish = createPublish(ctx);
  services.send = createSend(ctx);
  services.scheduler = createScheduler(ctx);
  services.drafts = createDrafts(ctx);
  services.snooze = createSnooze(ctx);
  services.labels = createLabels(ctx);
  services.rules = createRules(ctx);
  services.notify = createNotify(ctx, osNotifier);
  services.km = createKm(ctx);
  services.bb84 = createBb84(ctx);

  return { services, mail };
}
