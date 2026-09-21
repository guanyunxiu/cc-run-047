import type { BlockNode, InlineAttributes } from '@blockeditor/core';
import { domOffsetToModel, modelOffsetToDom, renderInline } from './dom.js';

/** 工具栏支持切换的行内格式键。 */
export type InlineMark = keyof Pick<
  InlineAttributes,
  'bold' | 'italic' | 'underline' | 'strike' | 'code'
>;

/** 块内选区（均为相对块首的模型字符偏移）。 */
export interface BlockSelection {
  blockId: string;
  anchor: number;
  head: number;
}

/**
 * TextBinding —— 单个块行内文本的 contentEditable 绑定。
 *
 * 设计原则：
 *  - DOM 仅作为 Y.XmlText 的渲染投影，绝不在 DOM 层累积编辑状态；
 *  - 本地输入走 beforeinput（insertText / insertParagraph / deleteContent…），
 *    翻译为 Y.XmlText 事务，再由"远端/本地统一"的渲染路径回流；
 *  - Yjs observe 触发时做最小 DOM 替换（整块行内内容），并保持选区；
 *  - 其他客户端的输入不会抢占本端选区（仅当编辑同一块时才恢复）。
 */
export class TextBinding {
  /** 编辑回调：由 EditorSession 提供，负责块拆分 / 合并 / 普通文本写入。 */
  onEdit:
    | ((action:
        | { type: 'insert'; index: number; text: string }
        | { type: 'delete'; index: number; length: number }
        | { type: 'replace'; index: number; deleteLength: number; text: string }
        | { type: 'split'; index: number }
        | { type: 'merge' }) => void)
    | null = null;

  /** 选区 / 光标变化：head 为光标端；anchor === head 时是折叠光标。 */
  onSelectionChange: ((selection: BlockSelection | null) => void) | null = null;
  /** 工具栏 / 快捷键请求切换一个行内格式（必须经会话层本地事务执行）。 */
  onToggleMark: ((mark: InlineMark) => void) | null = null;

  private destroyed = false;
  /**
   * 输入法合成中（IME composition，如中文选字）。
   * 合成期间：
   *  - beforeinput 一律放行（insertCompositionText / deleteCompositionText 由浏览器直接改 DOM）；
   *  - 任何 Yjs 回流都不重画该块（replaceChildren 会打断合成、清掉下划线和候选窗）；
   *  - 选区回调只更新位置，不触发 focusBlock 重新聚焦。
   */
  private composing = false;
  /** compositionend 之后可能迟到的 insertFromComposition，需要吞掉。 */
  private suppressNextCompositionInsert = false;

  constructor(
    readonly content: HTMLElement,
    readonly node: BlockNode,
  ) {
    content.contentEditable = 'true';
    content.spellcheck = false;
    this.render();
    content.addEventListener('beforeinput', this.handleBeforeInput);
    content.addEventListener('input', this.handleInput as EventListener);
    content.addEventListener('compositionstart', this.handleCompositionStart);
    content.addEventListener('compositionend', this.handleCompositionEnd);
    content.addEventListener('keydown', this.handleKeydown);
    content.addEventListener('keyup', this.scheduleEmitSelection);
    content.addEventListener('mouseup', this.scheduleEmitSelection);
    this.node.text.observe(this.handleYTextChange);
  }

  destroy(): void {
    this.destroyed = true;
    this.content.removeEventListener('beforeinput', this.handleBeforeInput);
    this.content.removeEventListener('input', this.handleInput as EventListener);
    this.content.removeEventListener('compositionstart', this.handleCompositionStart);
    this.content.removeEventListener('compositionend', this.handleCompositionEnd);
    this.content.removeEventListener('keydown', this.handleKeydown);
    this.content.removeEventListener('keyup', this.scheduleEmitSelection);
    this.content.removeEventListener('mouseup', this.scheduleEmitSelection);
    this.node.text.unobserve(this.handleYTextChange);
  }

  /** 是否正处于输入法合成中（会话层据此避免重新聚焦打断输入）。 */
  get isComposing(): boolean {
    return this.composing;
  }

  /** 当前块内选区；选区不在本块时返回 null。 */
  getSelection(): BlockSelection | null {
    const sel = document.getSelection();
    const anchor = sel?.anchorNode;
    if (!sel || sel.rangeCount === 0 || !anchor || !this.content.contains(anchor)) return null;
    return {
      blockId: this.node.id,
      anchor: domOffsetToModel(this.content, anchor, sel.anchorOffset),
      head: domOffsetToModel(this.content, sel.focusNode!, sel.focusOffset),
    };
  }

  /** 把选区恢复到本块（from/to 为模型偏移，允许保留非折叠选区）。 */
  setSelection(from: number, to: number): void {
    const start = modelOffsetToDom(this.content, from);
    const end = modelOffsetToDom(this.content, to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** 工具栏按钮 / 快捷键：请求对当前选区切换行内格式（事务由会话层执行）。 */
  toggleMark(mark: InlineMark): void {
    this.onToggleMark?.(mark);
  }

  // -------------------------------------------------------------------------
  // Y.XmlText -> DOM
  // -------------------------------------------------------------------------

  render(): void {
    if (this.destroyed) return;
    // IME 合成中绝不能替换 DOM：整块重画会清掉合成文本、下划线和候选窗。
    // 合成期间远端 / 本地事务回流直接跳过，commitComposition 后会以模型为准重画。
    if (this.composing) return;
    const hadFocus =
      this.content.contains(document.activeElement) || this.content === document.activeElement;
    // 工具栏点击会先让 contentEditable 失焦，此时仍保留最后已知选区，
    // 以 DOM 实际选区为准；失焦但 DOM 选区还在本块时同样保存。
    const saved = hadFocus ? this.saveSelection() : null;
    this.content.replaceChildren(renderInline(this.node.getDelta()));
    if (saved !== null) this.restoreSelection(saved);
  }

  private handleYTextChange = (): void => {
    // 无论本地还是远端事务，统一以 Yjs 数据为准重渲染该块行内容。
    this.render();
  };

  // -------------------------------------------------------------------------
  // 选区保持
  // -------------------------------------------------------------------------

  private saveSelection(): { anchor: number; head: number } | null {
    const sel = document.getSelection();
    const anchor = sel?.anchorNode;
    if (!sel || sel.rangeCount === 0 || !anchor || !this.content.contains(anchor)) return null;
    return {
      anchor: domOffsetToModel(this.content, anchor, sel.anchorOffset),
      head: domOffsetToModel(this.content, sel.focusNode!, sel.focusOffset),
    };
  }

  private restoreSelection(saved: { anchor: number; head: number }): void {
    this.setSelection(saved.anchor, saved.head);
  }

  private currentIndex(): number | null {
    return this.getSelection()?.head ?? null;
  }

  private scheduleEmitSelection = (): void => {
    this.onSelectionChange?.(this.getSelection());
  };

  // -------------------------------------------------------------------------
  // IME 合成（中文 / 日文 / 韩文输入法）
  // -------------------------------------------------------------------------

  private handleCompositionStart = (): void => {
    this.suppressNextCompositionInsert = false;
    this.composing = true;
  };

  private handleCompositionEnd = (): void => {
    if (!this.composing) return;
    // 先摘标志：commit 触发的模型事务回流要能正常重画。
    this.composing = false;
    this.suppressNextCompositionInsert = true;
    this.commitComposition();
  };

  /**
   * 合成结束时把浏览器写入 DOM 的最终文本翻译为一次模型替换：
   * 与合成前的块纯文本做公共前后缀 diff，改动区间用单个 replace 事务提交，
   * 一次输入法选词 = 一个可撤销单元，光标停在新词之后。
   */
  private commitComposition(): void {
    const before = this.node.getPlainText();
    const after = this.content.textContent ?? '';
    if (after === before) {
      // 空选（只打开输入法又取消）：以模型为准对齐一次。
      this.render();
      return;
    }
    let prefix = 0;
    const minLen = Math.min(before.length, after.length);
    while (prefix < minLen && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix++;
    }
    const deleteLength = before.length - prefix - suffix;
    const text = after.slice(prefix, after.length - suffix);
    if (deleteLength === 0 && text.length === 0) {
      this.render();
      return;
    }
    this.onEdit?.({
      type: 'replace',
      index: prefix,
      deleteLength,
      text,
    });
  }

  // -------------------------------------------------------------------------
  // DOM -> Y.XmlText（beforeinput 翻译）
  // -------------------------------------------------------------------------

  private handleBeforeInput = (event: InputEvent): void => {
    // IME 合成期间浏览器负责 DOM（insertCompositionText /
    // deleteCompositionText），绝不拦截，也不翻译：最终文本在
    // compositionend 统一提交。重画或聚焦都会打断输入法。
    if (this.composing) return;

    // 部分浏览器（旧 Chromium / Safari）会在 compositionend 后补发
    // insertFromComposition，该文本已在 compositionend 提交进模型，
    // 吞掉默认插入，随后由模型回流统一重画。
    if (
      event.inputType === 'insertFromComposition' ||
      event.inputType === 'insertCompositionText' ||
      event.inputType === 'deleteCompositionText'
    ) {
      if (this.suppressNextCompositionInsert) {
        this.suppressNextCompositionInsert = false;
        event.preventDefault();
      }
      return;
    }

    const index = this.currentIndex();
    if (index === null) return;
    event.preventDefault();

    switch (event.inputType) {
      case 'insertText':
        if (event.data) this.onEdit?.({ type: 'insert', index, text: event.data });
        break;
      case 'insertParagraph':
      case 'insertLineBreak':
        // Enter 统一走块拆分；Shift+Enter 在代码块内插换行。
        if (this.node.type === 'code' && event.inputType === 'insertLineBreak') {
          this.onEdit?.({ type: 'insert', index, text: '\n' });
        } else {
          this.onEdit?.({ type: 'split', index });
        }
        break;
      case 'deleteContentBackward':
        if (index === 0) {
          this.onEdit?.({ type: 'merge' });
        } else {
          this.onEdit?.({ type: 'delete', index: index - 1, length: 1 });
        }
        break;
      case 'deleteContentForward':
        this.onEdit?.({ type: 'delete', index, length: 1 });
        break;
      case 'deleteWordBackward': {
        const text = this.node.getPlainText().slice(0, index);
        const match = text.match(/\S*\s*$/);
        const len = match ? match[0].length : 1;
        this.onEdit?.({ type: 'delete', index: index - len, length: len });
        break;
      }
      case 'insertFromPaste':
        // 粘贴由块级 paste 处理器接管（见 EditorSurface），这里吞掉默认行为。
        break;
      default:
        // 未识别的输入不做默认 DOM 变更，避免 DOM 与模型漂移。
        break;
    }
  };

  private handleInput = (): void => {
    // 合成中 DOM 由输入法维护，不能重画。
    if (this.composing) return;
    // beforeinput 已 preventDefault 时正常不会触发；兜底再对齐一次。
    this.render();
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    // 粘贴（含全局块剪贴板）在 surface 层处理；此处仅拦截格式快捷键。
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      this.toggleMark('bold');
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.toggleMark('italic');
    }
  };
}
