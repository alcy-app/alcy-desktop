import { useState } from 'react'
import { CloseIcon } from '../../shared/ui/icons'

interface TokenInputProps {
  tokens: string[]
  placeholder: string
  inputAriaLabel: string
  removeAriaLabel: (token: string) => string
  onAdd: (token: string) => void
  onRemove: (token: string) => void
  mono?: boolean
}

/**
 * Lista de valores como chips dentro de um único campo: Enter confirma o
 * texto digitado; Backspace com o campo vazio remove o último.
 */
export function TokenInput({ tokens, placeholder, inputAriaLabel, removeAriaLabel, onAdd, onRemove, mono }: TokenInputProps) {
  const [draft, setDraft] = useState('')

  const commit = () => {
    const value = draft.trim()
    if (value === '') return
    onAdd(value)
    setDraft('')
  }

  return (
    <div className={mono ? 'vm-tokens vm-tokens--mono' : 'vm-tokens'}>
      {tokens.map((token) => (
        <span key={token} className="vm-token">
          <span className="vm-token-text">{token}</span>
          <button type="button" className="vm-token-remove" aria-label={removeAriaLabel(token)} onClick={() => onRemove(token)}>
            <CloseIcon size={10} />
          </button>
        </span>
      ))}
      <input
        className="vm-tokens-input"
        value={draft}
        placeholder={tokens.length === 0 ? placeholder : undefined}
        aria-label={inputAriaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Backspace' && draft === '' && tokens.length > 0) {
            onRemove(tokens[tokens.length - 1])
          }
        }}
      />
    </div>
  )
}
