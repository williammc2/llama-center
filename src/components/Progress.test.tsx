import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Progress } from './Progress'

describe('Progress', () => {
  it('shows determinate progress with percentage', () => {
    render(<Progress p={{ component: 'test', file: 'test.bin', received: 5 * 1024 * 1024, total: 10 * 1024 * 1024 }} />)
    expect(screen.getByText(/5 MB \/ 10 MB \(50%\)/)).toBeInTheDocument()
  })

  it('shows indeterminate progress without percentage', () => {
    render(<Progress p={{ component: 'test', file: 'test.bin', received: 3 * 1024 * 1024, total: null }} />)
    expect(screen.getByText(/3 MB/)).toBeInTheDocument()
  })

  it('caps percentage at 100%', () => {
    render(<Progress p={{ component: 'test', file: 'test.bin', received: 15 * 1024 * 1024, total: 10 * 1024 * 1024 }} />)
    expect(screen.getByText(/100%/)).toBeInTheDocument()
  })
})
