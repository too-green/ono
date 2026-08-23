import { Modal, type App } from "obsidian";

export interface PreviewableImage {
  name: string;
  url: string;
}

/** Opens the full-size image modal shared by timeline and composer attachments. */
export function openImagePreview(app: App, image: PreviewableImage): void {
  const modal = new Modal(app);
  modal.titleEl.setText(image.name);
  modal.contentEl.addClass("opencode-session-view__image-modal");
  modal.contentEl.createEl("img", { attr: { src: image.url, alt: image.name }, cls: "opencode-session-view__image-modal-img" });
  modal.open();
}
