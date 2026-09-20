/**
 * The simulated QKD Key Manager, as the app's screens reach it.
 *
 * One login: the KM account is the signed-in mailbox. Every call names the
 * active session's address, so being signed in to the mailbox is being logged
 * in to its Key Manager, and signing out leaves nothing that can ask for keys.
 * The keys themselves never reach this layer (`core/src/km.rs`).
 */
import { core, CoreError, KmLink, KmStatus } from '../core';
import { Ctx, KmService } from './contracts';

export function createKm(ctx: Ctx): KmService {
  const mailbox = () => {
    const email = ctx.store.get().session?.email;
    if (!email) throw new CoreError('Sign in to a mailbox to use its Key Manager.', 'no-key');
    return email;
  };

  return {
    status: (): Promise<KmStatus> => core.kmStatus(mailbox()),
    regenerate: (): Promise<KmStatus> => core.kmRegenerate(mailbox()),
    exportLink: (): Promise<KmLink> => core.kmExportLink(mailbox()),
    importLink: (blob: string, code: string): Promise<KmStatus> => core.kmImportLink(mailbox(), blob, code),
  };
}
