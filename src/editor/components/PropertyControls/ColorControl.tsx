import { useState } from 'react'
import type { ControlProps } from './shared'
import { ControlRow } from './ControlRow'
import { TokenizedColorField } from './TokenizedColorField'

interface ColorControlProps extends ControlProps<string> {
  format?: 'hex' | 'rgba'
  placeholder?: string
}

export function ColorControl({
  propKey,
  value,
  onChange,
  label,
  placeholder,
  isOverride,
  disabled,
  layout,
}: ColorControlProps) {
  const stringValue = String(value ?? '')
  // Track the last `stringValue` we adopted so we can resync local edit state
  // when the upstream value changes (parent commit, undo, external patch).
  // This is React's documented "store information from previous renders"
  // pattern — preferred over a useEffect that calls setState, which would
  // cause an extra render pass.
  const [text, setText] = useState(stringValue)
  const [lastSyncedValue, setLastSyncedValue] = useState(stringValue)
  if (lastSyncedValue !== stringValue) {
    setLastSyncedValue(stringValue)
    setText(stringValue)
  }

  const handleTextBlur = () => {
    // Validate before committing
    const s = text.trim()
    const isTokenReference = /^var\(\s*--[a-z0-9_-]+\s*\)$/i.test(s)
    const cssSupportsColor =
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        ? CSS.supports('color', s)
        : true
    if (s === '' || isTokenReference || cssSupportsColor) {
      onChange(propKey, s)
    } else {
      // Revert to last known-good value
      setText(String(value ?? ''))
    }
  }

  function handleSwatchChange(nextValue: string) {
    setText(nextValue)
    onChange(propKey, nextValue)
  }

  function handleTokenSelect(nextValue: string) {
    setText(nextValue)
    onChange(propKey, nextValue)
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      inputId={`ctrl-${propKey}-text`}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <TokenizedColorField
        id={`ctrl-${propKey}-text`}
        value={text}
        disabled={disabled}
        inputLabel={label ?? propKey}
        swatchLabel={`${label ?? propKey} colour swatch`}
        placeholder={placeholder ?? '#000000 or rgb(...)'}
        fieldSize="sm"
        monospace
        onTextChange={setText}
        onTextBlur={handleTextBlur}
        onSwatchChange={handleSwatchChange}
        onTokenSelect={handleTokenSelect}
      />
    </ControlRow>
  )
}
