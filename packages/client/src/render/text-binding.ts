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
        | { type: 'replace'; index: number; length: number; text: string }
        | { type: 'split'; index: number }
        | { type: 'merge' }) => void)
    | null = null;

  /** 选区 / 光标变化：head 为光标端；anchor === head 时是折叠光标。 */
  onSelectionChange: ((selection: BlockSelection | null) => void) | null = null;
  /** 工具栏 / 快捷键请求切换一个行内格式（必须经会话层本地事务执行）。 */
  onToggleMark: ((mark: InlineMark) => void) | null = null;

  private destroyed = false;
  /**
   * 输入法组字状态（compositionstart -> compositionend）。
   *
   * 组字期间：
   *  - beforeinput 一律不 preventDefault，insertCompositionText 交给浏览器原生处理；
   *  - 不按 Yjs 投影重画 DOM（否则候选词下划线会被清掉，输入法直接中断）；
   *  - 不上报选区 / 焦点变化（光标移动不重新聚焦，避免打断输入法）。
   * 选词确认（compositionend）后再把整段结果一次性写进模型。
   */
  private composing = false;
  /** composition 开始时的块内模型选区（from/to 已排序）。 */
  private compositionStart: { from: number; to: number } | null = null;

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
    // 输入法组字期间浏览器正在直接维护 DOM（含候选词下划线），
    // 此时整段重画会打断系统输入法；等 compositionend 后再对齐。
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
    // 组字期间浏览器内部不断调整选区（候选词移动），上报会导致会话层
    // 重新聚焦，打断输入法；compositionend 后由提交逻辑统一设置光标。
    if (this.composing) return;
    this.onSelectionChange?.(this.getSelection());
  };

  // -------------------------------------------------------------------------
  // 输入法组字（IME composition）
  // -------------------------------------------------------------------------

  private handleCompositionStart = (): void => {
    this.composing = true;
    const selection = this.getSelection();
    if (selection) {
      this.compositionStart = {
        from: Math.min(selection.anchor, selection.head),
        to: Math.max(selection.anchor, selection.head),
      };
    } else {
      this.compositionStart = null;
    }
  };

  private handleCompositionEnd = (event: CompositionEvent): void => {
    const start = this.compositionStart;
    this.composing = false;
    this.compositionStart = null;

    const data = event.data ?? '';
    // 有选区时组字会替换选区；先记录落点。
    const replaceFrom = start?.from ?? null;
    const replaceTo = start?.to ?? null;

    if (data.length > 0 && replaceFrom !== null && replaceTo !== null && replaceTo > replaceFrom) {
      // 选词替换选区：删 + 插合为一个模型事务（单步撤销、一次同步），
      // 与普通打字链路一致。
      this.onEdit?.({
        type: 'replace',
        index: replaceFrom,
        length: replaceTo - replaceFrom,
        text: data,
      });
    } else if (data.length > 0) {
      // 折叠光标处确认选词：插在组字开始时的光标位置。
      // 组字起点缺失（异常情况）时 currentIndex 读到的是含未提交文字的
      // DOM 偏移，会超出模型长度，用当前模型文本长度夹取。
      const maxIndex = this.node.getPlainText().length;
      const index = Math.min(replaceFrom ?? this.currentIndex() ?? 0, maxIndex);
      this.onEdit?.({ type: 'insert', index, text: data });
    } else {
      // 取消组字 / 空结果：DOM 是浏览器组字时的残留，按模型重新对齐。
      this.render();
    }
  };

  // -------------------------------------------------------------------------
  // DOM -> Y.XmlText（beforeinput 翻译）
  // -------------------------------------------------------------------------

  private handleBeforeInput = (event: InputEvent): void => {
    // 输入法组字（insertCompositionText / deleteCompositionText 等）交给
    // 浏览器原生修改 DOM，结果在 compositionend 时统一提交进模型。
    if (this.composing || event.isComposing) return;
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

  private handleInput = (event: Event): void => {
    // 组字中的 input 是浏览器原生在改 DOM，不能按模型重画；
    // compositionend 之后模型写入本身会触发 render。
    if (this.composing || (event as InputEvent).isComposing) return;
    // beforeinput 已 preventDefault，正常不会触发；兜底再对齐一次。
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
