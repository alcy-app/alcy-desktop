import { useCallback, useState } from 'react'

export function useEditorSearch(initiallyOpen = false) {
  const [isOpen, setIsOpen] = useState(initiallyOpen)
  const openSearch = useCallback(() => {
    setIsOpen(true)
    return true
  }, [])
  const closeSearch = useCallback(() => setIsOpen(false), [])
  return { isOpen, openSearch, closeSearch }
}
