import { SignedAgentBridge } from "./bridge.js";
import { ContactStore } from "./contacts.js";
import { CursorStore } from "./cursors.js";
import { IdentityStore } from "./identity.js";
import { MailboxStore } from "./mailboxes.js";
import { NonceStore } from "./nonce-store.js";
import { bridgePaths } from "./paths.js";
import type { TechnocoreTransport } from "./types.js";
import type { PassphraseProvider } from "./passphrase.js";

export function createStores(root?: string, passphrases?: PassphraseProvider) {
  const paths = bridgePaths(root);
  return {
    paths,
    identities: new IdentityStore(paths.identities, passphrases),
    mailboxes: new MailboxStore(paths.mailboxes),
    contacts: new ContactStore(paths.contacts),
    cursors: new CursorStore(paths.cursors),
    nonces: new NonceStore(paths.nonces),
  };
}

export function createBridge(
  transport: TechnocoreTransport,
  root?: string,
  passphrases?: PassphraseProvider,
): SignedAgentBridge {
  const { paths: _paths, ...stores } = createStores(root, passphrases);
  return new SignedAgentBridge(stores, transport);
}
