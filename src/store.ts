export interface Expense {
  /** The number that sent the expense. */
  sender: string;
  /** The sender's WhatsApp profile name, when known. */
  senderName?: string;
  messageId: string;
  amountCents: number;
  reason: string;
  /** Unix epoch milliseconds */
  createdAt: number;
}

/**
 * A code that lets another number join an account.
 * An account's id is the number that owns it: every number starts with its own account,
 * and a number that redeems an invite is linked to the inviter's account instead.
 */
export interface Invite {
  code: string;
  accountId: string;
  createdBy: string;
  createdByName?: string;
  /** Unix epoch milliseconds */
  expiresAt: number;
}

export interface ExpenseStore {
  /**
   * Records that a message was handled. Resolves false if it was already handled
   * (Meta retries webhook deliveries, so the same message can arrive more than once).
   */
  markProcessed(messageId: string): Promise<boolean>;
  add(accountId: string, expense: Expense): Promise<void>;
  /** All expenses of an account, oldest first. */
  list(accountId: string): Promise<Expense[]>;

  /** The shared account a number is linked to, or null when it uses its own account. */
  linkedAccount(phone: string): Promise<string | null>;
  /** True when other numbers are linked to this account. */
  hasMembers(accountId: string): Promise<boolean>;
  /** Saves a new invite. Resolves false if the code is already taken. */
  createInvite(invite: Invite): Promise<boolean>;
  getInvite(code: string): Promise<Invite | null>;
  /**
   * Atomically uses up the invite and links the number to the invite's account.
   * Resolves false if the invite no longer exists (e.g. someone else just used it).
   */
  redeemInvite(code: string, phone: string): Promise<boolean>;
  /** Unlinks a number from its shared account. Resolves false if it was not linked. */
  unlink(phone: string): Promise<boolean>;
  /** Moves every expense of one account into another. Resolves the number of expenses moved. */
  moveExpenses(fromAccountId: string, toAccountId: string): Promise<number>;
}

/** In-memory store, used by tests. */
export class MemoryExpenseStore implements ExpenseStore {
  #processed = new Set<string>();
  /** accountId -> messageId -> expense */
  #expenses = new Map<string, Map<string, Expense>>();
  /** phone -> accountId */
  #links = new Map<string, string>();
  #invites = new Map<string, Invite>();

  async markProcessed(messageId: string): Promise<boolean> {
    if (this.#processed.has(messageId)) return false;
    this.#processed.add(messageId);
    return true;
  }

  async add(accountId: string, expense: Expense): Promise<void> {
    this.#account(accountId).set(expense.messageId, expense);
  }

  async list(accountId: string): Promise<Expense[]> {
    return [...this.#account(accountId).values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async linkedAccount(phone: string): Promise<string | null> {
    return this.#links.get(phone) ?? null;
  }

  async hasMembers(accountId: string): Promise<boolean> {
    return [...this.#links.values()].includes(accountId);
  }

  async createInvite(invite: Invite): Promise<boolean> {
    if (this.#invites.has(invite.code)) return false;
    this.#invites.set(invite.code, invite);
    return true;
  }

  async getInvite(code: string): Promise<Invite | null> {
    return this.#invites.get(code) ?? null;
  }

  async redeemInvite(code: string, phone: string): Promise<boolean> {
    const invite = this.#invites.get(code);
    if (!invite) return false;
    this.#invites.delete(code);
    this.#links.set(phone, invite.accountId);
    return true;
  }

  async unlink(phone: string): Promise<boolean> {
    return this.#links.delete(phone);
  }

  async moveExpenses(fromAccountId: string, toAccountId: string): Promise<number> {
    const from = this.#account(fromAccountId);
    const to = this.#account(toAccountId);
    for (const [id, expense] of from) to.set(id, expense);
    const moved = from.size;
    from.clear();
    return moved;
  }

  #account(accountId: string): Map<string, Expense> {
    let expenses = this.#expenses.get(accountId);
    if (!expenses) {
      expenses = new Map();
      this.#expenses.set(accountId, expenses);
    }
    return expenses;
  }
}
