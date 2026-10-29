// Touring markets per region. Each city is a candidate stop. TourSmith pulls
// one Qloo heatmap for the whole region (the `wkt` boundary) and scores every
// city from the grid cells around it, so scores are comparable across cities.
// `query` is the natural-language location Qloo resolves for per-city
// recommendations; lat/lng anchors the city on the heat grid and the map.

export const REGIONS = {
  us: {
    wkt: "POLYGON((-125 24, -66 24, -66 49.5, -125 49.5, -125 24))",
    label: "United States",
    within: "United States",
    center: [39.5, -98.35],
    zoom: 4,
    cities: [
      { name: "New York", query: "New York City", lat: 40.7128, lng: -74.006 },
      { name: "Los Angeles", query: "Los Angeles", lat: 34.0522, lng: -118.2437 },
      { name: "Chicago", query: "Chicago", lat: 41.8781, lng: -87.6298 },
      { name: "Nashville", query: "Nashville", lat: 36.1627, lng: -86.7816 },
      { name: "Austin", query: "Austin, Texas", lat: 30.2672, lng: -97.7431 },
      { name: "Atlanta", query: "Atlanta", lat: 33.749, lng: -84.388 },
      { name: "Denver", query: "Denver", lat: 39.7392, lng: -104.9903 },
      { name: "Seattle", query: "Seattle", lat: 47.6062, lng: -122.3321 },
      { name: "Boston", query: "Boston", lat: 42.3601, lng: -71.0589 },
      { name: "Philadelphia", query: "Philadelphia", lat: 39.9526, lng: -75.1652 },
      { name: "Minneapolis", query: "Minneapolis", lat: 44.9778, lng: -93.265 },
      { name: "Phoenix", query: "Phoenix, Arizona", lat: 33.4484, lng: -112.074 },
      { name: "Dallas", query: "Dallas", lat: 32.7767, lng: -96.797 },
      { name: "Kansas City", query: "Kansas City, Missouri", lat: 39.0997, lng: -94.5786 },
      { name: "Salt Lake City", query: "Salt Lake City", lat: 40.7608, lng: -111.891 },
      { name: "Columbus", query: "Columbus, Ohio", lat: 39.9612, lng: -82.9988 },
    ],
  },
  uk: {
    wkt: "POLYGON((-11 49.8, 2 49.8, 2 59, -11 59, -11 49.8))",
    label: "UK & Ireland",
    within: "United Kingdom",
    center: [54.0, -3.5],
    zoom: 5,
    cities: [
      { name: "London", query: "London", lat: 51.5074, lng: -0.1278 },
      { name: "Manchester", query: "Manchester, UK", lat: 53.4808, lng: -2.2426 },
      { name: "Glasgow", query: "Glasgow", lat: 55.8642, lng: -4.2518 },
      { name: "Birmingham", query: "Birmingham, UK", lat: 52.4862, lng: -1.8904 },
      { name: "Leeds", query: "Leeds", lat: 53.8008, lng: -1.5491 },
      { name: "Bristol", query: "Bristol, UK", lat: 51.4545, lng: -2.5879 },
      { name: "Edinburgh", query: "Edinburgh", lat: 55.9533, lng: -3.1883 },
      { name: "Liverpool", query: "Liverpool", lat: 53.4084, lng: -2.9916 },
      { name: "Dublin", query: "Dublin", lat: 53.3498, lng: -6.2603 },
      { name: "Belfast", query: "Belfast", lat: 54.5973, lng: -5.9301 },
      { name: "Cardiff", query: "Cardiff", lat: 51.4816, lng: -3.1791 },
      { name: "Newcastle", query: "Newcastle upon Tyne", lat: 54.9783, lng: -1.6178 },
    ],
  },
  apac: {
    wkt: "POLYGON((95 22, 180 22, 180 -48, 95 -48, 95 22))",
    label: "Southeast Asia & Australia",
    within: "Southeast Asia",
    center: [-5, 120],
    zoom: 3,
    cities: [
      { name: "Kuala Lumpur", query: "Kuala Lumpur", lat: 3.139, lng: 101.6869 },
      { name: "Singapore", query: "Singapore", lat: 1.3521, lng: 103.8198 },
      { name: "Jakarta", query: "Jakarta", lat: -6.2088, lng: 106.8456 },
      { name: "Bangkok", query: "Bangkok", lat: 13.7563, lng: 100.5018 },
      { name: "Manila", query: "Manila", lat: 14.5995, lng: 120.9842 },
      { name: "Ho Chi Minh City", query: "Ho Chi Minh City", lat: 10.8231, lng: 106.6297 },
      { name: "Penang", query: "George Town, Penang", lat: 5.4141, lng: 100.3288 },
      { name: "Sydney", query: "Sydney", lat: -33.8688, lng: 151.2093 },
      { name: "Melbourne", query: "Melbourne", lat: -37.8136, lng: 144.9631 },
      { name: "Brisbane", query: "Brisbane", lat: -27.4698, lng: 153.0251 },
      { name: "Perth", query: "Perth, Australia", lat: -31.9505, lng: 115.8605 },
      { name: "Auckland", query: "Auckland", lat: -36.8485, lng: 174.7633 },
    ],
  },
  eu: {
    wkt: "POLYGON((-10 36, 25 36, 25 61, -10 61, -10 36))",
    label: "Continental Europe",
    within: "Europe",
    center: [50, 10],
    zoom: 4,
    cities: [
      { name: "Paris", query: "Paris", lat: 48.8566, lng: 2.3522 },
      { name: "Berlin", query: "Berlin", lat: 52.52, lng: 13.405 },
      { name: "Amsterdam", query: "Amsterdam", lat: 52.3676, lng: 4.9041 },
      { name: "Barcelona", query: "Barcelona", lat: 41.3874, lng: 2.1686 },
      { name: "Madrid", query: "Madrid", lat: 40.4168, lng: -3.7038 },
      { name: "Milan", query: "Milan", lat: 45.4642, lng: 9.19 },
      { name: "Stockholm", query: "Stockholm", lat: 59.3293, lng: 18.0686 },
      { name: "Copenhagen", query: "Copenhagen", lat: 55.6761, lng: 12.5683 },
      { name: "Brussels", query: "Brussels", lat: 50.8503, lng: 4.3517 },
      { name: "Vienna", query: "Vienna", lat: 48.2082, lng: 16.3738 },
      { name: "Prague", query: "Prague", lat: 50.0755, lng: 14.4378 },
      { name: "Lisbon", query: "Lisbon", lat: 38.7223, lng: -9.1393 },
    ],
  },
  ca: {
    wkt: "POLYGON((-141 42, -52 42, -52 60, -141 60, -141 42))",
    label: "Canada",
    within: "Canada",
    center: [52, -100],
    zoom: 3,
    cities: [
      { name: "Toronto", query: "Toronto", lat: 43.6532, lng: -79.3832 },
      { name: "Vancouver", query: "Vancouver", lat: 49.2827, lng: -123.1207 },
      { name: "Montreal", query: "Montreal", lat: 45.5017, lng: -73.5673 },
      { name: "Calgary", query: "Calgary", lat: 51.0447, lng: -114.0719 },
      { name: "Edmonton", query: "Edmonton", lat: 53.5461, lng: -113.4938 },
      { name: "Ottawa", query: "Ottawa", lat: 45.4215, lng: -75.6972 },
      { name: "Winnipeg", query: "Winnipeg", lat: 49.8951, lng: -97.1384 },
      { name: "Halifax", query: "Halifax, Nova Scotia", lat: 44.6488, lng: -63.5752 },
    ],
  },
};

// Score each city from the region heat grid.
// affinity: Qloo's measure of how strongly this act over-indexes in a cell
// versus everything else people there engage with, ranked across the whole
// region grid. score = 100 × mean of the top 3 cells within RADIUS_KM.
// popularity: how dense the act's signal is in those cells (a scene-size proxy).
export const RADIUS_KM = 50;
export function scoreCities(cities, points) {
  return cities.map((city) => {
    const near = points.filter((p) => haversineKm(city, p) <= RADIUS_KM);
    if (!near.length) return { ...city, score: null, affinity: null, popularity: null, cells: 0, note: "No Qloo heat signal near this city" };
    const top = near.map((p) => p.affinity).sort((a, b) => b - a).slice(0, 3);
    const affinity = top.reduce((a, b) => a + b, 0) / top.length;
    const pops = near.map((p) => p.popularity).filter((v) => typeof v === "number");
    const popularity = pops.length ? pops.reduce((a, b) => a + b, 0) / pops.length : null;
    return {
      ...city,
      score: Math.round(affinity * 100),
      affinity: Number(affinity.toFixed(3)),
      popularity: popularity === null ? null : Number(popularity.toFixed(3)),
      cells: near.length,
    };
  });
}

export function regionList() {
  return Object.entries(REGIONS).map(([id, r]) => ({
    id,
    label: r.label,
    center: r.center,
    zoom: r.zoom,
    cities: r.cities.map((c) => c.name),
  }));
}

// Order stops so the route doesn't zig-zag: nearest-neighbour from every
// possible starting city, keeping the shortest total path. Plenty for 3–8
// stops; a promoter still sets the actual dates.
export function orderRoute(stops) {
  if (stops.length <= 2) return stops;
  let best = null;
  let bestKm = Infinity;
  for (let start = 0; start < stops.length; start++) {
    const remaining = stops.filter((_, i) => i !== start);
    const route = [stops[start]];
    let km = 0;
    while (remaining.length) {
      const last = route[route.length - 1];
      let idx = 0;
      let d = Infinity;
      remaining.forEach((c, i) => {
        const dd = haversineKm(last, c);
        if (dd < d) {
          d = dd;
          idx = i;
        }
      });
      km += d;
      route.push(remaining.splice(idx, 1)[0]);
    }
    if (km < bestKm) {
      bestKm = km;
      best = route;
    }
  }
  return best;
}

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
