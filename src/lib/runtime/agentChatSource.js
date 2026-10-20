// P-9.12: the deployed-runtime AgentChat widget — its SOURCE, embedded into the runtime
// module (src/lib/runtime/runtimeSource.js) as code. The string holds the component only:
// a compact conversation UI composed EXCLUSIVELY of the certified agents methods
// (createConversation / getConversation / subscribeToConversation / addMessage) — the same
// documented server contract and projections P-9.10B/P-9.11 certified, no second agent
// engine and no local message store. Plain h() calls on purpose: no template syntax, so the
// embedded source survives the runtime's single-module assembly verbatim.
export default `
// AgentChat (P-9.12). Props: agent (agent name to START a conversation with) or
// conversationId (an EXISTING conversation to LOAD), plus optional class / maxHeight.
// The anonymous session token minted on a conversation-start op is captured by the HOST
// page (PublicApp) and never enters widget state, storage or any payload the widget builds.
export function AgentChat(props) {
  const agentName = props.agent || props.agentName || null;
  const initialId = props.conversationId || null;
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(!initialId);
  const [error, setError] = useState(null);
  // Flow: an existing conversation id is LOADED through the certified get read; an agent
  // name STARTS one through the certified create. Both render the documented projection —
  // a create returns the conversation WITHOUT messages (rendered as an empty list), a get
  // returns it WITH its embedded messages.
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        let conv = null;
        if (initialId) {
          const r = await agents.getConversation(initialId);
          conv = (r && r.conversation) || null;
        } else if (agentName) {
          conv = await agents.createConversation(agentName);
        }
        if (stopped) return;
        setConversation(conv);
        setMessages(conv && Array.isArray(conv.messages) ? conv.messages : []);
      } catch (e) { if (!stopped) setError(String((e && e.message) || e)); }
      finally { if (!stopped) setStarting(false); }
    })();
    return () => { stopped = true; };
  }, [agentName, initialId]);
  // Live updates: the certified bounded-poll subscription. The callback IS the documented
  // conversation projection (messages embedded); the unsubscribe is returned straight to
  // the runtime so React's cleanup stops it on unmount and on conversation change.
  useEffect(() => {
    const id = conversation && conversation.conversation_id;
    if (!id) return undefined;
    return agents.subscribeToConversation(id, (c) => {
      if (c && c.error) { setError(String(c.error)); return; }
      if (c && Array.isArray(c.messages)) setMessages(c.messages);
    });
  }, [conversation && conversation.conversation_id]);
  // Send: the certified addMessage — the documented message object form with role 'user'
  // (the only inbound role the server accepts) and content. The refreshed read is the same
  // get projection the subscription rides, so the reply lands in place.
  const send = async () => {
    const text = String(draft || '').trim();
    if (!text || busy || !conversation || !conversation.conversation_id) return;
    setBusy(true); setError(null);
    try {
      await agents.addMessage(conversation, { role: 'user', content: text });
      setDraft('');
      const r = await agents.getConversation(conversation.conversation_id);
      setMessages(Array.isArray(r.messages) ? r.messages : []);
    } catch (e) { setError(String((e && e.message) || e)); }
    finally { setBusy(false); }
  };
  const row = (m, i) => h('div', {
    key: m.id || 'm-' + i,
    style: {
      alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
      background: m.role === 'user' ? '#3b5bfd' : '#f1f1f4',
      color: m.role === 'user' ? '#ffffff' : '#1c1c24',
      borderRadius: '10px', padding: '8px 12px', maxWidth: '85%',
      fontSize: '13px', fontFamily: 'inherit', lineHeight: 1.45,
    }
  },
    h('div', null, String(m.content || '') || (m.streaming ? '…' : '')),
    (m.tool_calls || []).map((tc, j) => h('div', {
      key: 'tc-' + j,
      style: { fontSize: '11px', marginTop: '4px', opacity: 0.75 }
    }, String(tc.name || 'tool') + (tc.status ? ' · ' + tc.status : '')))
  );
  return h('div', { class: props.class || '', style: {
    border: '1px solid #e5e5e5', borderRadius: '12px', background: '#ffffff',
    padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px',
    minHeight: '160px', maxHeight: props.maxHeight || '420px', overflow: 'auto',
    fontFamily: 'inherit',
  } },
    starting ? h('div', { style: { fontSize: '12px', color: '#77777e' } }, 'Starting conversation…') : null,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, overflow: 'auto' } }, messages.map(row)),
    error ? h('div', { style: { fontSize: '12px', color: '#c02626' } }, error) : null,
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
      h('input', {
        value: draft,
        onInput: (e) => setDraft(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') send(); },
        placeholder: 'Message the agent…',
        disabled: busy || !conversation,
        style: { flex: 1, padding: '8px 10px', border: '1px solid #e5e5e5', borderRadius: '10px', fontSize: '13px', fontFamily: 'inherit', outline: 'none' }
      }),
      h('button', {
        onClick: send, disabled: busy || !conversation,
        style: { padding: '8px 14px', border: '0', borderRadius: '10px', background: '#3b5bfd', color: '#ffffff', fontSize: '13px', fontFamily: 'inherit', cursor: busy ? 'default' : 'pointer', opacity: busy || !conversation ? 0.5 : 1 }
      }, busy ? '…' : 'Send')
    )
  );
}`;