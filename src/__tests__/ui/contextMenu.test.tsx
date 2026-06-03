import { afterEach, describe, expect, it, mock } from 'bun:test'
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'

afterEach(cleanup)

function PointContextMenuHarness({
  onClose,
  onTargetClick,
}: {
  onClose: () => void
  onTargetClick: () => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <>
      <button type="button" onClick={onTargetClick}>
        Different element
      </button>
      {open && (
        <ContextMenu
          x={24}
          y={32}
          ariaLabel="Node options"
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <ContextMenuItem onClick={() => {}}>Rename</ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}

describe('ContextMenu', () => {
  it('lets the first outside click close a point menu and activate the clicked target', () => {
    const onClose = mock(() => {})
    const onTargetClick = mock(() => {})

    render(
      <PointContextMenuHarness
        onClose={onClose}
        onTargetClick={onTargetClick}
      />,
    )

    expect(screen.getByRole('menu', { name: /node options/i })).toBeDefined()

    const target = screen.getByRole('button', { name: /different element/i })
    fireEvent.mouseDown(target)
    fireEvent.click(target)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onTargetClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu', { name: /node options/i })).toBeNull()
  })
})
