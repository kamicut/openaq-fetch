'use strict';
import { REQUEST_TIMEOUT } from '../lib/constants';
import { default as baseRequest } from 'request';
import { default as moment } from 'moment-timezone';
import cheerio from 'cheerio';

import { waterfall, series, parallel, parallelLimit } from 'async';
const request = baseRequest.defaults({timeout: REQUEST_TIMEOUT});
export const name = 'israel';

export function fetchData (source, callback) {
  const regionPageTasks = regionPages(9, 20, source.url);
  parallel(
    regionPageTasks,
    (err, res) => {
      if (err) {
        return ({message: 'Unknown adapter error'}, null);
      }
      callback(null, [].concat.apply(res));
    }
  );
}

// link of lists for each region's site page
const regionPages = (start, end, source) => [...Array(end - start + 1)].map((_, i) => {
  source = source.replace('<id>', (start + i));
  return handleState(source);
});

/* return data for all stations in each region
 *
 * 1) use handleStation to make list funcs that get data from each station link
 * 2) merge each response into a measurements lists
 * 3) comebine these with each region name
 *
 */
var handleState = function (source) {
  return (callback) => {
    waterfall([
      (callback) => {
        let headers = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Content-Type': 'text/html; charset=utf-8',
          'Referer': 'http://www.svivaaqm.net/MenuSite.aspx'
        };
        request.get({
          url: source,
          headers: headers
        }, (err, res, body) => {
          if (err || res.statusCode !== 200) {
            return callback({message: 'Failed to access: ' + source}, null);
          }
          let $ = cheerio.load(body);
          // get regoin name from <span> with this id
          let name = $('#lblCaption').text().split('- ')[1];
          if (name) { name = name.split('').reverse().join(''); }
          // grab all <a></a> elements and get attached links
          const links = $('a');
          let stationLinks = [];
          links.map((a) => {
            stationLinks.push(links[a].attribs.href);
          });
          // station data and their averaging intervals exist on two separate pages
          // so, two lists of requests are made. One for data, the other for
          // interavls.
          const stationDataRequests = handleStation(stationLinks, headers, source);
          const stationIntervalRequests = handleInterval(stationLinks, headers, source);

          callback(null, [stationDataRequests, stationIntervalRequests], name);
        });
      },
      (stationRequests, name, callback) => {
        // pass stationDataRequests and stationIntervalRequests into
        // their own async parallels sitting in an async. series
        // upon their completion, map intervals to the different stations'
        // interval values.
        series([
          (callback) => {
            parallelLimit(stationRequests[0], 2,
              (err, results) => {
                if (err) {
                  return callback({message: 'Failed to gather measurements for:' + name}, []);
                }
                // merge each measurements list into one large list
                callback(null, results, name);
              }
            );
          },
          (callback) => {
            let intervalsFin;
            parallelLimit(
              stationRequests[1], 2,
              (err, results) => {
                if (err) {
                  return callback({message: 'Failed to gather measurements for:' + name}, []);
                }
                // merge each measurements list into one large list
                intervalsFin = [].concat.apply([], results);
                callback(null, intervalsFin, name);
              }
            );
          }
        ], (err, results) => {
          if (err) {
            return callback({message: 'Failed to gather data and intervals'}, []);
          }
          results[0][0].forEach((val, index) => {
            val.forEach((innerVal, innerIndex) => {
              results[0][0][index][innerIndex].averagingPeriod.value = results[1][0][index];
            });
          });
          const finMeasurements = [].concat.apply([], results[0][0]);
          callback(null, finMeasurements);
        });
      },
      (measurementsFin, callback) => {
        if (!(measurementsFin.length === 0)) {
          const aqObj = {};
          aqObj['name'] = 'Israel';
          aqObj['measurements'] = measurementsFin;
          callback(null, aqObj);
        }
      }
    ], (err, res) => {
      if (err) {
        return callback({message: 'There was an error parsing data from the source'}, []);
      }
      callback(null, res);
    });
  };
};

/* make list of functions to grab data from each region page
 * each of these functsion does the following
 *
 * 1) get links for each of the regions' station pages, then return a measurement list for each station as well as region name
 * 2) merge each station's measurement list into one large list of measurements for entire region
 * 3) generate a final object that meets open-aq standard with region name and measurements
 *
 */
var handleStation = function (stationLinks, headers, source) {
  return stationLinks
    .filter((link) => { return link !== undefined; })
    .filter((link) => { return link.match(/StationInfo5/); })
    .map((link) => {
      link = 'http://www.svivaaqm.net/' + link;
      return function (callback) {
        headers.Referer = source;
        request.get({
          url: link,
          headers: headers
        }, (err, res, body) => {
          if (err || res.statusCode !== 200) {
            return callback(err, [{}]);
          }
          let [aqData, coords] = parseData(body);
          // populate measurements array
          const measurements = [];
          // aqData.lenght === 3 indicates data recorded.
          // if shorter, do nothing.
          if (aqData.length > 2) {
            aqData[0].forEach((val, index) => {
              // ignore the first element, it holds the title and date.
              if (index > 0) {
                const pollutant = aqData[0][index];
                // only create objs when the pollutent one tracked by openAQ
                if (includes(['SO2', 'PM10', 'PM2.5', 'No2', 'O3'], pollutant)) {
                  const value = aqData[2][index];
                  // further, only create the object if the measurement is not NaN, or nothing
                  if (!(isNaN(parseInt(value)))) {
                    // make date in Jerusalem time.
                    const time = moment.tz(
                      aqData[2][0],
                      'DD/MM/YYYY HH:mm:ss',
                      'Asia/Jerusalem'
                    );
                    const measurement = {
                      parameter: pollutant,
                      date: {
                        utc: time.toDate(),
                        local: time.format()
                      },
                      coordinates: {
                        latitude: coords[1],
                        longitude: coords[0]
                      },
                      value: value,
                      unit: aqData[1][index],
                      attribution: [{
                        name: 'Israel Ministry of Environmental Protection',
                        url: 'http://svivaaqm.net/'
                      }],
                      // thes below are place holders. these are changed to correct periods
                      averagingPeriod: {
                        unit: 'hours',
                        value: 'time'
                      }
                    };
                    measurements.push(measurement);
                  }
                }
              }
            });
          }
          callback(null, measurements);
        });
      };
    });
};

/* make list of functions to grab data from each region page
 * each of these functsion does the following
 *
 * 1) get links for each of the regions' station pages, then return a measurement list for each station as well as region name
 * 2) merge each station's measurement list into one large list of measurements for entire region
 * 3) generate a final object that meets open-aq standard with region name and measurements
 *
 */
var handleInterval = function (stationLinks, headers, source) {
  return stationLinks
    .filter((link) => { return link !== undefined; })
    .filter((link) => { return link.match(/StationInfo5/); })
    .map((link) => {
      link = 'http://www.svivaaqm.net/' + link.replace('StationInfo5', 'StationReportFast');
      return function (callback) {
        headers.Referer = source;
        request.get({
          url: link,
          headers: headers
        }, (err, res, body) => {
          if (err || res.statusCode !== 200) {
            return callback(err, [{}]);
          }
          const $ = cheerio.load(body);
          let interval = $('#ddlTimeBase').children().first().text();
          if (interval.match(/Minutes/)) {
            interval = parseInt(interval.split(' ')[0]) / 60;
          } else {
            interval = interval.split(' ')[0];
          }
          callback(null, interval);
        });
      };
    });
};
/* take in data from page and return [list of rows, coordinates] */
var parseData = function (pageBody) {
  let $ = cheerio.load(pageBody);
  // get the data table
  let aqData = [];
  // get text from each cell and push it to aqData
  $('table #C1WebGrid1 > tr', 'td').each((i, el) => {
    let data = $(el).children().text().match(/\r\n\t(.*?)\r\n/g);
    data = data.map((dataPoint) => {
      return dataPoint.replace(/\r\n/g, '').replace(/\t/g, '');
    });
    aqData.push(data);
  });
  // get coordinates
  const coords = [];
  // find the 6th + 7th child of table selected.
  // these are longitude & latitude, in that order
  $('div #stationInfoDiv > table').each((i, el) => {
    $(el).children().each((j, element) => {
      if (j === 6 || j === 7) {
        const coord = $(element).html()
          .split('"value">')[1]
          .split('<')[0];
        coords.push(coord);
      }
    });
  });
  return [aqData, coords];
};
