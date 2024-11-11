const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const polyline = require('@mapbox/polyline');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());

function decodePolyline(encodedPolyline) {
  return polyline.decode(encodedPolyline);
}

let accessToken = '';

mongoose.connect('mongodb://localhost:27017/stravaCycling')
  .then(() => console.log('Conectado a MongoDB'))
  .catch(err => console.error('Error al conectar a MongoDB:', err));

const routeSchema = new mongoose.Schema({
  activityId: { type: Number, unique: true },  // Añadido el campo activityId con índice único
  distance: Number,
  elevation: Number,
  duration: Number,
  coordinates: String,
  date: Date,
  type: String,
});

const Route = mongoose.model('Route', routeSchema);

// Ruta para obtener el token de acceso
app.get('/auth', (req, res) => {
  const clientId = '137258';
  const redirectUri = 'http://localhost:3000/callback';
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=read,activity:read,read_all`;
  res.redirect(authUrl);
});

// Ruta de callback para obtener el token
app.get('/callback', async (req, res) => {
  const authorizationCode = req.query.code;

  if (!authorizationCode) {
    return res.send('No se recibió un código de autorización');
  }

  try {
    const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
      client_id: '137258',
      client_secret: '6e18d322637f36dfc95e80b8500205880a98d801',
      code: authorizationCode,
      grant_type: 'authorization_code',
    });

    accessToken = tokenResponse.data.access_token;
    console.log(`Token de acceso obtenido: ${accessToken}`);
    res.send('Token de acceso obtenido. Ahora puedes consultar las actividades en /getActivities o generar recomendaciones en /filteredRoutes.');
  } catch (error) {
    console.error('Error al obtener el token de acceso:', error.response?.data || error.message);
    res.send('Error al obtener el token de acceso');
  }
});

// Ruta para obtener actividades de ciclismo y guardarlas en MongoDB
app.get('/getActivities', async (req, res) => {
  if (!accessToken) {
    return res.send('No hay token de acceso disponible. Por favor, autentícate primero.');
  }

  let page = 1;
  let moreActivities = true;

  try {
    while (moreActivities) {
      const activitiesResponse = await axios.get(`https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (activitiesResponse.data.length === 0) {
        moreActivities = false;
      } else {
        // Filtrar actividades de ciclismo con polyline y activityId válidos
        const cyclingActivities = activitiesResponse.data
          .filter(activity => activity.type === 'Ride' && activity.map.summary_polyline && activity.id);

        if (cyclingActivities.length === 0) {
          moreActivities = false;
        } else {
          // Filtrar actividades ya guardadas en MongoDB
          const existingIds = await Route.find({ activityId: { $in: cyclingActivities.map(a => a.id) } }, 'activityId').lean();
          const existingIdsSet = new Set(existingIds.map(r => r.activityId));

          const routesToSave = cyclingActivities
            .filter(activity => !existingIdsSet.has(activity.id))
            .map(activity => ({
              activityId: activity.id,  // Guardar activityId para evitar duplicados
              distance: activity.distance,
              elevation: activity.total_elevation_gain,
              duration: activity.moving_time,
              coordinates: activity.map.summary_polyline,
              date: new Date(activity.start_date),
              type: activity.type,
            }));

          if (routesToSave.length > 0) {
            await Route.insertMany(routesToSave, { ordered: false });
          }
          page++;
        }
      }
    }

    res.send('Rutas de ciclismo guardadas en la base de datos');
  } catch (error) {
    console.error('Error al obtener o guardar actividades de ciclismo:', error.message, error.response?.data || '');
    res.send('Error al obtener o guardar actividades de ciclismo');
  }
});

// Endpoint para filtrar rutas por desnivel
app.get('/filteredRoutes', async (req, res) => {
  const { minElevation, maxElevation } = req.query;

  const filters = {};

  if (minElevation) filters.elevation = { ...filters.elevation, $gte: parseFloat(minElevation) };
  if (maxElevation) filters.elevation = { ...filters.elevation, $lte: parseFloat(maxElevation) };

  try {
    const filteredRoutes = await Route.find(filters);
    const decodedRoutes = filteredRoutes.map(route => ({
      distance: route.distance,
      elevation: route.elevation,
      duration: route.duration,
      coordinates: decodePolyline(route.coordinates),
    }));

    res.send(decodedRoutes);
  } catch (error) {
    console.error('Error al filtrar rutas:', error);
    res.status(500).send('Error al filtrar rutas');
  }
});

// Endpoint para obtener rutas populares basadas en frecuencia
app.get('/popularRoutes', async (req, res) => {
  try {
    const distanceTolerance = 1000; // Tolerancia de 1 km
    const elevationTolerance = 50; // Tolerancia de 50 m

    const popularRoutes = await Route.aggregate([
      {
        $project: {
          normalizedDistance: { $subtract: ["$distance", { $mod: ["$distance", distanceTolerance] }] },
          normalizedElevation: { $subtract: ["$elevation", { $mod: ["$elevation", elevationTolerance] }] },
          distance: "$distance",
          elevation: "$elevation",
          coordinates: "$coordinates"
        }
      },
      {
        $group: {
          _id: { normalizedDistance: "$normalizedDistance", normalizedElevation: "$normalizedElevation" },
          count: { $sum: 1 },
          routes: { $push: "$$ROOT" }
        }
      },
      { $match: { count: { $gt: 1 } } }, // Solo mostrar rutas que han sido repetidas
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const decodedRoutes = popularRoutes.map(group => {
      const route = group.routes[0]; // Tomar una ruta representativa del grupo
      return {
        distance: route.distance,
        elevation: route.elevation,
        count: group.count,
        coordinates: decodePolyline(route.coordinates),
      };
    });

    res.send(decodedRoutes);
  } catch (error) {
    console.error('Error al generar rutas populares:', error);
    res.status(500).send('Error al generar rutas populares');
  }
});

app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});