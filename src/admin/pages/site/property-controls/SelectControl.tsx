import type { ControlProps } from './shared'
import { Select } from '@ui/components/Select'
import { ControlRow } from '@ui/components/ControlRow'

interface SelectOption {
  label: string
  value: unknown
}

interface SelectControlProps extends ControlProps<unknown> {
  options: SelectOption[]
  placeholder?: string
}

export function SelectControl({
  propKey,
  value,
  onChange,
  label,
  options,
  placeholder,
  isOverride,
  disabled,
  layout,
}: SelectControlProps) {
  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <Select
        id={`ctrl-${propKey}`}
        value={String(value ?? '')}
        placeholder={placeholder}
        disabled={disabled}
        fieldSize="sm"
        onChange={(e) => {
          const raw = e.target.value
          const matched = options.find((o) => String(o.value) === raw)
          onChange(propKey, matched !== undefined ? matched.value : raw)
        }}
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </Select>
    </ControlRow>
  )
}
