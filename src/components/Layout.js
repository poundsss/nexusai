import { html, useState, useEffect, auth, navigate, Link } from '@/lib/runtime';

export default function Layout({ children, currentPath = '/' }) {
  const [user, setUser] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    auth.me().then(u => setUser(u)).catch(() => setUser(null));
  }, []);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/customers?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const navLinks = [
    {
      name: 'Dashboard',
      path: '/dashboard',
      icon: (active) => html`
        <svg class="w-5 h-5 mr-3 ${active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
        </svg>
      `
    },
    {
      name: 'Customers & Leads',
      path: '/customers',
      icon: (active) => html`
        <svg class="w-5 h-5 mr-3 ${active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
        </svg>
      `
    },
    {
      name: 'Weather',
      path: '/weather',
      icon: (active) => html`
        <svg class="w-5 h-5 mr-3 ${active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 00-9.78 2.096A4.001 4.001 0 003 15z"/>
        </svg>
      `
    }
  ];

  const isLinkActive = (path) => {
    if (path === '/dashboard') {
      return currentPath === '/dashboard';
    }
    return currentPath.startsWith(path);
  };

  return html`
    <div class="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      <!-- Sidebar Desktop -->
      <aside class="w-full md:w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div class="h-16 flex items-center justify-between px-6 border-b border-slate-200">
          <${Link} href="/dashboard" class="flex items-center space-x-2.5 text-indigo-600 font-bold text-xl tracking-tight">
            <div class="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center shadow-sm font-black">
              C
            </div>
            <span class="text-slate-900 font-semibold text-lg">Pulse<span class="text-indigo-600">CRM</span></span>
          <//>
          <button 
            onClick=${() => setMobileMenuOpen(!mobileMenuOpen)}
            class="md:hidden text-slate-500 hover:text-slate-700 p-1 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>
        </div>

        <!-- Nav Links -->
        <div class="${mobileMenuOpen ? 'block' : 'hidden'} md:block flex-1 p-4 space-y-1.5">
          <p class="px-3 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Menu</p>
          ${navLinks.map((item) => {
            const active = isLinkActive(item.path);
            return html`
              <${Link}
                key=${item.path}
                href=${item.path}
                onClick=${() => setMobileMenuOpen(false)}
                class="group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                  active
                    ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-xs'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }"
              >
                ${item.icon(active)}
                ${item.name}
              <//>
            `;
          })}

      <div class="pt-6 mt-6 border-t border-slate-100">
            <p class="px-3 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Quick Action</p>
            <${Link}
              href="/customers?new=1"
              class="w-full flex items-center justify-center px-3 py-2 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-colors"
            >
              <svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
              </svg>
              New Customer
            <//>
          </div>
        </div>

        <!-- User Profile Footer -->
        <div class="border-t border-slate-200 p-4 bg-slate-50/70">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3 overflow-hidden mr-2">
              <div class="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center shrink-0 border border-indigo-200 text-sm">
                ${user?.full_name ? user.full_name.charAt(0).toUpperCase() : 'U'}
              </div>
              <div class="truncate">
                <p class="text-sm font-medium text-slate-900 truncate">${user?.full_name || 'CRM Agent'}</p>
                <p class="text-xs text-slate-500 truncate">${user?.email || 'agent@crm.internal'}</p>
              </div>
            </div>
            <button 
              onClick=${() => auth.logout()}
              title="Sign Out"
              class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
              </svg>
            </button>
          </div>
        </div>
      </aside>

      <!-- Main Workspace -->
      <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
        <!-- Top Search Bar -->
        <header class="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between shrink-0">
          <form onSubmit=${handleSearchSubmit} class="flex-1 max-w-lg">
            <div class="relative">
              <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                </svg>
              </div>
              <input
                type="search"
                value=${searchQuery}
                onInput=${(e) => setSearchQuery(e.target.value)}
                placeholder="Search leads, companies, or emails..."
                class="w-full pl-9 pr-4 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white text-slate-800 transition-colors"
              />
            </div>
          </form>
          <div class="flex items-center space-x-3 ml-4">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
              <span class="w-1.5 h-1.5 mr-1.5 rounded-full bg-emerald-500"></span>
              Live Sync
            </span>
          </div>
        </header>

        <!-- Main Content Area -->
        <main class="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          ${children}
        </main>
      </div>
    </div>
  `;
}