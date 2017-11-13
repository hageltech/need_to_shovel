'use latest';

const DarkSkyApi = require('dark-sky-api');
const Pushover = require('pushover-notifications');
const moment = require('moment-timezone');

const DEBUG_LEVEL = 1;
const TZ = 'America/Toronto'; 

// Snow levels (in cm) that are worth waking up early to
const MINIMUM_SNOW_0500 = 40;
const MINIMUM_SNOW_0600 = 20;
const MINIMUM_SNOW_0630 = 5;

// **************************************************************************************
// Sends persistent notification to PushOver service, if snow precipation is above 
// pre-set values (see above). Need to wake up earlier to shovel...
// There are 3 pre-set snow levels (in cm): one to get up at 5am, one for 5:30 and one for 6am
// TODO: Extract whole time/snow-level logic into an external configuration file.
//
function pushNotificationIfNeeded(context, cb, snowLevel) {
  const now = moment().tz(TZ);
  const time0500 = now.clone().startOf('day').hours(5);
  const time0600 = time0500.clone().hours(6);
  const time0630 = time0600.clone().minutes(30);

  if ((now.isAfter(time0500) && (snowLevel > MINIMUM_SNOW_0500)) ||
      (now.isAfter(time0600) && (snowLevel > MINIMUM_SNOW_0600)) ||
      (now.isAfter(time0630) && (snowLevel > MINIMUM_SNOW_0630))) {
      
    var p = new Pushover({
    	user: context.secrets.pushover_user,
	    token: context.secrets.pushover_token,
	    onerror: function(error) { cb(error) },
    });
    
    // Pushover message: priority is 2, so it's persistent, Alarm-stream message on android
    // that has to be manually cancelled (just like alarm clock)
    var msg = {
    	message: 'Time to wake up, there is over ' + snowLevel + 'cm of snow outside!',
    	title: 'Time to Shovel!',
    	sound: 'persistent',
    	retry: 60,
    	expire: 6*60*60,
    	priority: (DEBUG_LEVEL > 2) ? 0 : 2
    };
    
    // Send message to pushover
    p.send(msg, function(err, result) {
    	if (err) {
    	  console.log("Cannot send pushover notification: ", err);
    		cb(err);
    	}
  	  console.log("Sent pushover notification: ", result);
  	  // Store current time so no more messages will be sent today
  	  context.storage.set( { lastMessageSent: moment().tz(TZ).format("YYYY-MM-DD") }, function (error) {
          if (error) return cb(error);
      });
  	  return true;
    });
  }
  return false;  
}


// **************************************************************************************
// Get snow precipation levels from DarkSky, and calculate accumulated level  
// between yesterday 10pm and today 8am
function getPrecipationData(context, cb) {
    // Geographic position for precipation data
  var position = {
    latitude: context.secrets.latitude, 
    longitude: context.secrets.longitude
  };
  const darkSkyYesterday = new DarkSkyApi(context.secrets.dark_sky_key, true, 'si');
  const darkSkyToday = new DarkSkyApi(context.secrets.dark_sky_key, true, 'si');

  // Get precipitation levels since yesterday's evening into today's morning. Two DarkSky API call required
  Promise.all([
    darkSkyYesterday.initialize(position).loadTime(moment().tz(TZ).subtract(1, 'days').startOf('day')),
    darkSkyToday.initialize(position).loadTime(moment().tz(TZ).startOf('day')),
  ]).then(([yesterday, today, forecast]) => {
      
      // We're interested in snowfall between yesterday 10pm and today 8am
      var yesterdayEvening = moment().tz(TZ).subtract(1, 'days').hours(21).minutes(0).seconds(0).milliseconds(0);
      var todayMorning = moment().tz(TZ).hours(22).minutes(0).seconds(0);

      // Map DarkSky data into array of time/snowlevel tuples for relevant timespan 
      var snowArray = yesterday.hourly.data.concat(today.hourly.data).map( 
          function(x) {
            return { time: moment(x.time, "X").tz(TZ), snow: x.precipAccumulation || 0 }        
          }).filter( 
          function(x) { 
            return x.time.isBetween(yesterdayEvening.utc(), todayMorning.utc()) }
          );

      // Calculate the total snow level for the time period (in centimeters)
      var snowTotal = snowArray.reduce( function(sum, val) { return sum + val.snow }, 0);
      
      if (DEBUG_LEVEL > 2) {
        console.log("Snow levels: ", snowArray.map( function(x) { return { time: x.time.format(), snow: x.snow }}));  
      }
      if (DEBUG_LEVEL > 1) {
        console.log("Total snow level: ", snowTotal);
      }
      if (pushNotificationIfNeeded(context, cb, snowTotal)) {
        cb(null, "Snow level is " + snowTotal + "cm, message has been sent!");
      } else {
        cb(null, "Snow level is " + snowTotal + "cm, no need to shovel!");
      }
    }
  ).catch(err => {
      console.log("Error: ", err);
      cb(err);
  });
}


// **************************************************************************************
// Main entry point
module.exports = function(context, cb) {

  // TODO: Skip the whole excersise on weekends
  // Get time when last message was sent
  context.storage.get(function (error, data) {
        if (error) return cb(error);
        if (data && (data.lastMessageSent == moment().tz(TZ).format("YYYY-MM-DD"))) {
          console.log("Message was already sent today, exiting.");
          cb(null, "Message was already sent today!");
        } else {
          getPrecipationData(context, cb);
        }
    });  

};

