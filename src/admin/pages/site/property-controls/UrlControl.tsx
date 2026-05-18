import { useState } from 'react'
import type { ControlProps } from './shared'
import { isValidUrl } from '@core/utils/urlValidation'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import controlRowStyles from '@ui/components/ControlRow/ControlRow.module.css'

export function UrlControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
  layout,
}: ControlProps<string>) {
  const [error, setError] = useState(false)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    const valid = isValidUrl(v)
    setError(!valid)
    if (valid) onChange(propKey, v)
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={error ? (
        <span className={controlRowStyles.labelError} role="alert">Invalid URL</span>
      ) : undefined}
    >
      <Input
        id={`ctrl-${propKey}`}
        type="url"
        value={String(value ?? '')}
        placeholder="https://…"
        disabled={disabled}
        fieldSize="sm"
        onChange={handleChange}
        invalid={error}
      />
    </ControlRow>
  )
}
