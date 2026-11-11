import { createHash } from "node:crypto";
import { type Firestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Expense, ExpenseStore, Invite } from "./store.ts";

/** gRPC status code Firestore returns when create() hits an existing document. */
const ALREADY_EXISTS = 6;
/** A write batch holds at most 500 operations; a move is a set plus a delete per expense. */
const MOVE_BATCH_SIZE = 200;

/** WhatsApp message ids are base64 and may contain "/", which is not allowed in a document id. */
function docId(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

interface ExpenseDoc {
  messageId: string;
  amountCents: number;
  reason: string;
  createdAt: Timestamp;
  /** Missing on expenses saved before shared accounts existed: the sender is then the account owner. */
  sender?: string;
  senderName?: string;
}

interface InviteDoc {
  accountId: string;
  createdBy: string;
  createdByName?: string;
  expiresAt: Timestamp;
}

/**
 * Layout:
 *   users/{accountId}/expenses/{sha256(messageId)}  { amountCents, reason, messageId, createdAt, sender, senderName }
 *   links/{phone}                                   { accountId, linkedAt }   // number -> shared account
 *   inviteCodes/{code}                              { accountId, createdBy, createdByName, expiresAt }
 *   processedMessages/{sha256(messageId)}           { messageId, processedAt }
 *
 * An account's id is the number of its owner, so a number that was never linked uses users/{its number}.
 */
export class FirestoreExpenseStore implements ExpenseStore {
  #db: Firestore;

  constructor(db: Firestore) {
    this.#db = db;
  }

  async markProcessed(messageId: string): Promise<boolean> {
    try {
      await this.#db
        .collection("processedMessages")
        .doc(docId(messageId))
        .create({ messageId, processedAt: FieldValue.serverTimestamp() });
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === ALREADY_EXISTS) return false;
      throw error;
    }
  }

  async add(accountId: string, expense: Expense): Promise<void> {
    const doc: ExpenseDoc = {
      messageId: expense.messageId,
      amountCents: expense.amountCents,
      reason: expense.reason,
      createdAt: Timestamp.fromMillis(expense.createdAt),
      sender: expense.sender,
    };
    if (expense.senderName) doc.senderName = expense.senderName;
    await this.#expenses(accountId).doc(docId(expense.messageId)).set(doc);
  }

  async list(accountId: string): Promise<Expense[]> {
    const snapshot = await this.#expenses(accountId).orderBy("createdAt").get();
    return snapshot.docs.map((doc) => {
      const data = doc.data() as ExpenseDoc;
      const expense: Expense = {
        sender: data.sender ?? accountId,
        messageId: data.messageId,
        amountCents: data.amountCents,
        reason: data.reason,
        createdAt: data.createdAt.toMillis(),
      };
      if (data.senderName) expense.senderName = data.senderName;
      return expense;
    });
  }

  async linkedAccount(phone: string): Promise<string | null> {
    const snapshot = await this.#links().doc(phone).get();
    return snapshot.exists ? ((snapshot.data() as { accountId: string }).accountId ?? null) : null;
  }

  async hasMembers(accountId: string): Promise<boolean> {
    const snapshot = await this.#links().where("accountId", "==", accountId).limit(1).get();
    return !snapshot.empty;
  }

  async createInvite(invite: Invite): Promise<boolean> {
    const doc: InviteDoc = {
      accountId: invite.accountId,
      createdBy: invite.createdBy,
      expiresAt: Timestamp.fromMillis(invite.expiresAt),
    };
    if (invite.createdByName) doc.createdByName = invite.createdByName;
    try {
      await this.#invites().doc(invite.code).create(doc);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === ALREADY_EXISTS) return false;
      throw error;
    }
  }

  async getInvite(code: string): Promise<Invite | null> {
    const snapshot = await this.#invites().doc(code).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data() as InviteDoc;
    const invite: Invite = {
      code,
      accountId: data.accountId,
      createdBy: data.createdBy,
      expiresAt: data.expiresAt.toMillis(),
    };
    if (data.createdByName) invite.createdByName = data.createdByName;
    return invite;
  }

  async redeemInvite(code: string, phone: string): Promise<boolean> {
    const inviteRef = this.#invites().doc(code);
    return this.#db.runTransaction(async (tx) => {
      const snapshot = await tx.get(inviteRef);
      if (!snapshot.exists) return false;
      const { accountId } = snapshot.data() as InviteDoc;
      tx.delete(inviteRef);
      tx.set(this.#links().doc(phone), { accountId, linkedAt: FieldValue.serverTimestamp() });
      return true;
    });
  }

  async unlink(phone: string): Promise<boolean> {
    const ref = this.#links().doc(phone);
    return this.#db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      tx.delete(ref);
      return true;
    });
  }

  async moveExpenses(fromAccountId: string, toAccountId: string): Promise<number> {
    const from = this.#expenses(fromAccountId);
    const to = this.#expenses(toAccountId);
    let moved = 0;
    for (;;) {
      const snapshot = await from.limit(MOVE_BATCH_SIZE).get();
      if (snapshot.empty) return moved;
      const batch = this.#db.batch();
      for (const doc of snapshot.docs) {
        // Expenses saved before shared accounts existed have no sender: it was the account owner.
        batch.set(to.doc(doc.id), { sender: fromAccountId, ...doc.data() });
        batch.delete(doc.ref);
      }
      await batch.commit();
      moved += snapshot.size;
    }
  }

  #expenses(accountId: string) {
    return this.#db.collection("users").doc(accountId).collection("expenses");
  }

  #links() {
    return this.#db.collection("links");
  }

  #invites() {
    return this.#db.collection("inviteCodes");
  }
}
