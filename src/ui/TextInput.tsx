import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * A typed way in, for when speaking isn't the right tool — a question that
 * shouldn't be said out loud, a room too noisy to be heard in, a mic that
 * isn't cooperating right now. It only ever replaces the listening half.
 * Whatever comes back still comes back as speech, the same as any spoken
 * turn — this is not a text-chat mode, just another door into the one loop.
 *
 * Opened with C, closed with Escape or by sending. Unmounted rather than
 * hidden while closed, so nothing here holds focus or intercepts a key when
 * nobody asked it to.
 */
export function TextInput({
  open,
  onSubmit,
  onClose,
}: {
  open: boolean
  onSubmit: (text: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.form
        className="text-input"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18 }}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(ref.current?.value ?? '')
          if (ref.current) ref.current.value = ''
        }}
      >
        <input
          ref={ref}
          type="text"
          className="text-input-field"
          placeholder="An JARVIS schreiben …"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          onBlur={onClose}
        />
      </motion.form>
    </AnimatePresence>
  )
}
