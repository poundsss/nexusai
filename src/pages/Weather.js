import { html, useState, useEffect } from '@/lib/runtime';
import { server } from '@/lib/runtime';

const PRESET_CITIES = ['New York', 'London', 'Tokyo', 'San Francisco', 'Paris', 'Sydney'];

export default function Weather() {
  const [cityInput, setCityInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [weatherData, setWeatherData] = useState(null);
  const [error, setError] = useState(null);

  async function fetchWeather(targetCity) {
    const queryCity = (targetCity || cityInput || '').trim();
    if (!queryCity) return;
    
    setLoading(true);
    setError(null);

    try {
      const result = await server.getWeather({ city: queryCity });
      if (result && result.error) {
        setError(result.error);
        setWeatherData(null);
      } else {
        setWeatherData(result);
        setCityInput(result.location || queryCity);
      }
    } catch (err) {
      setError(err?.message || 'Unable to retrieve weather data. Please try again.');
      setWeatherData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWeather('New York');
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    fetchWeather();
  }

  return html`
    <div class="space-y-6 max-w-5xl mx-auto">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-200 pb-5">
        <div>
          <h1 class="text-2xl font-bold text-gray-900 tracking-tight">Weather Intelligence</h1>
          <p class="text-sm text-gray-500 mt-1">Check live local weather conditions before contacting global clients and scheduling meetings.</p>
        </div>
      </div>

      <div class="bg-white shadow rounded-lg p-5 border border-gray-100">
        <form onSubmit=${handleSubmit} class="flex flex-col sm:flex-row gap-3">
          <div class="relative flex-1">
            <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              class="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-600 focus:border-blue-600 sm:text-sm"
              placeholder="Enter city name (e.g. Chicago, Berlin, Singapore)..."
              value=${cityInput}
              onInput=${(e) => setCityInput(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled=${loading || !cityInput.trim()}
            class="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
          >
            ${loading ? html`
              <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
              </svg>
              Fetching...
            ` : 'Search Weather'}
          </button>
        </form>

        <div class="mt-4 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span class="font-medium text-gray-700">Quick select:</span>
          ${PRESET_CITIES.map(city => html`
            <button
              key=${city}
              type="button"
              onClick=${() => { setCityInput(city); fetchWeather(city); }}
              class="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-medium transition-colors"
            >
              ${city}
            </button>
          `)}
        </div>
      </div>

      ${error && html`
        <div class="rounded-md bg-red-50 p-4 border border-red-200">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div class="ml-3 text-sm text-red-700 font-medium">
              ${error}
            </div>
          </div>
        </div>
      `}

      ${weatherData && !loading && html`
        <div class="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl shadow-lg p-6 sm:p-8 text-white">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
            <div>
              <div class="flex items-center gap-2 text-blue-100 text-sm font-medium tracking-wide uppercase">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd" />
                </svg>
                ${weatherData.location || cityInput}
              </div>
              <div class="text-5xl sm:text-6xl font-extrabold tracking-tight mt-2">
                ${Math.round(weatherData.temperature ?? 0)}°C
              </div>
              <div class="text-lg text-blue-100 mt-1 font-medium capitalize">
                ${weatherData.condition || 'Clear Sky'}
              </div>
            </div>
            <div class="bg-white/10 backdrop-blur-sm rounded-xl p-4 sm:p-6 grid grid-cols-2 gap-4 text-center min-w-[200px]">
              <div class="p-2">
                <span class="text-xs text-blue-200 block uppercase tracking-wider">Humidity</span>
                <span class="text-xl font-bold mt-1 block">${weatherData.humidity ?? '--'}%</span>
              </div>
              <div class="p-2 border-l border-white/10">
                <span class="text-xs text-blue-200 block uppercase tracking-wider">Wind</span>
                <span class="text-xl font-bold mt-1 block">${weatherData.windSpeed ?? '--'} km/h</span>
              </div>
            </div>
          </div>
        </div>
      `}

      <div class="bg-white shadow rounded-lg p-6 border border-gray-100">
        <h3 class="text-base font-semibold text-gray-900">Client Outreach Tip</h3>
        <p class="mt-2 text-sm text-gray-600 leading-relaxed">
          Tailoring your opening conversation with local context or time zone sensitivity builds stronger rapport with remote prospects and partners.
        </p>
      </div>
    </div>
  `;
}