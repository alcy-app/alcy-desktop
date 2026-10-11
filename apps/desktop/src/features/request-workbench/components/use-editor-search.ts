import { useCallback, useState } from 'react'

export function useEditorSearch() {
  const [isOpen, setIsOpen] = useState(false)
  const openSearch = useCallback(() => {
    setIsOpen(true)
    return true
  }, [])
  const closeSearch = useCallback(() => setIsOpen(false), [])
  return { isOpen, openSearch, closeSearch }
}
