import { secrets } from "base44:runtime";
import { http } from "../../shared/http.ts";

export default async function (req: Request): Promise<Response> {
  try {
    let body: any = {};
    try { body = await req.json(); } catch (_) {}
    const city = body && body.city;
    if (!city) {
      return Response.json({ error: "City parameter is required" }, { status: 400 });
    }

    const apiKey = secrets.get("WEATHER_API_KEY");

    try {
      if (apiKey) {
        const geoRes = await http("https://api.openweathermap.org/geo/1.0/direct", {
          method: "GET",
          query: { q: city, limit: 1, appid: apiKey },
        });
        if (!geoRes.ok || !geoRes.body || geoRes.body.length === 0) {
          return Response.json({ error: "City not found" }, { status: 404 });
        }
        const location = geoRes.body[0];
        const weatherRes = await http("https://api.openweathermap.org/data/2.5/weather", {
          method: "GET",
          query: { lat: location.lat, lon: location.lon, units: "metric", appid: apiKey },
        });
        if (!weatherRes.ok) {
          return Response.json({ error: "Weather API request failed" }, { status: 502 });
        }
        const w = weatherRes.body;
        return Response.json({
          city: location.name,
          country: location.country,
          temp: Math.round(w.main.temp),
          feels_like: Math.round(w.main.feels_like),
          condition: w.weather[0] ? w.weather[0].main : "Unknown",
          description: w.weather[0] ? w.weather[0].description : "",
          humidity: w.main.humidity,
          wind: Math.round(w.wind.speed * 3.6),
        }, { status: 200 });
      } else {
        // Fallback: Open-Meteo Geocoding & Weather API (no API key required).
        const geoRes = await http("https://geocoding-api.open-meteo.com/v1/search", {
          method: "GET",
          query: { name: city, count: 1 },
        });
        if (!geoRes.ok || !geoRes.body || !geoRes.body.results || geoRes.body.results.length === 0) {
          return Response.json({ error: "City not found" }, { status: 404 });
        }
        const loc = geoRes.body.results[0];
        const weatherRes = await http("https://api.open-meteo.com/v1/forecast", {
          method: "GET",
          query: {
            latitude: loc.latitude,
            longitude: loc.longitude,
            current_weather: "true",
            hourly: "relativehumidity_2m",
          },
        });
        if (!weatherRes.ok || !weatherRes.body || !weatherRes.body.current_weather) {
          return Response.json({ error: "Weather forecast request failed" }, { status: 502 });
        }
        const cur = weatherRes.body.current_weather;
        const humidityList = weatherRes.body.hourly ? weatherRes.body.hourly.relativehumidity_2m : null;
        const humidity = humidityList && humidityList.length ? humidityList[0] : 60;
        return Response.json({
          city: loc.name,
          country: loc.country_code || loc.country || "",
          temp: Math.round(cur.temperature),
          feels_like: Math.round(cur.temperature),
          condition: cur.weathercode > 3 ? "Cloudy / Rain" : "Clear / Sunny",
          description: "Current weather condition",
          humidity: humidity,
          wind: Math.round(cur.windspeed),
        }, { status: 200 });
      }
    } catch (err: any) {
      return Response.json({ error: err.message || "Internal server error" }, { status: 500 });
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
