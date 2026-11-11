export interface WhatsAppSender {
  react(to: string, messageId: string, emoji: string): Promise<void>;
  sendText(to: string, body: string): Promise<void>;
}

/** Minimal WhatsApp Cloud API client. */
export class WhatsAppClient implements WhatsAppSender {
  #url: string;
  #token: string;

  constructor(options: { token: string; phoneNumberId: string; apiVersion: string }) {
    this.#url = `https://graph.facebook.com/${options.apiVersion}/${options.phoneNumberId}/messages`;
    this.#token = options.token;
  }

  async react(to: string, messageId: string, emoji: string): Promise<void> {
    await this.#post({ to, type: "reaction", reaction: { message_id: messageId, emoji } });
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.#post({ to, type: "text", text: { body, preview_url: false } });
  }

  async #post(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });
    if (!response.ok) {
      throw new Error(`WhatsApp API ${response.status}: ${await response.text()}`);
    }
  }
}
