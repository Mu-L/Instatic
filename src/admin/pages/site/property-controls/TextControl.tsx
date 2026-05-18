import type { ControlProps } from './shared'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'

interface TextControlProps extends ControlProps<string> {
  placeholder?: string
}

export function TextControl({
  propKey,
  value,
  onChange,
  label,
  placeholder,
  isOverride,
  disabled,
  layout,
}: TextControlProps) {
  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <Input
        id={`ctrl-${propKey}`}
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        fieldSize="sm"
        onChange={(e) => onChange(propKey, e.target.value)}
      />
    </ControlRow>
  )
}
