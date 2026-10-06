import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Conversation } from '@/lib/types'

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [searchKw, setSearchKw] = useState('')

  const load = useCallback(async () => {
    const r = await api.listConversations()
    if (r.success) setConversations(r.data || [])
  }, [])

  const create = useCallback(async (title: string) => {
    const r = await api.createConversation(title)
    if (r.success && r.data) {
      setCurrentId(r.data.id)
      await load()
    }
    return r
  }, [load])

  const remove = useCallback(async (id: number) => {
    const r = await api.deleteConversation(id)
    if (r.success) {
      if (currentId === id) setCurrentId(null)
      await load()
    }
  }, [currentId, load])

  useEffect(() => { load() }, [load])

  const filtered = searchKw
    ? conversations.filter(c => (c.title || '').toLowerCase().includes(searchKw.toLowerCase()))
    : conversations

  return { conversations: filtered, currentId, setCurrentId, create, remove, reload: load, searchKw, setSearchKw }
}
