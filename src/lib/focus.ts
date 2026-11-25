export interface FocusCheckOptions {
  mode: string;
  hotkeyRecording: boolean;
}

export interface FocusableInput {
  value?: string;
  focus?: (options?: { preventScroll?: boolean }) => void;
  setSelectionRange?: (start: number, end: number) => void;
}

export interface FocusInputOptions extends FocusCheckOptions {
  input: FocusableInput | null;
}

export function shouldAutoFocusTextInput({ mode, hotkeyRecording }: FocusCheckOptions): boolean {
  return mode === "main" && !hotkeyRecording;
}

export function focusTextInputIfAllowed({
  mode,
  hotkeyRecording,
  input,
}: FocusInputOptions): boolean {
  if (!shouldAutoFocusTextInput({ mode, hotkeyRecording })) {
    return false;
  }

  if (!input || typeof input.focus !== "function") {
    return false;
  }

  input.focus({ preventScroll: true });

  // 呼出窗口后把光标放到末尾，用户可以直接继续输入或追加内容。
  const value = typeof input.value === "string" ? input.value : "";
  if (typeof input.setSelectionRange === "function") {
    const caret = value.length;
    input.setSelectionRange(caret, caret);
  }

  return true;
}
