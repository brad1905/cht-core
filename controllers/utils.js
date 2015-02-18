var _ = require('underscore'),
    moment = require('moment'),
    async = require('async'),
    db = require('../db'),
    config = require('../config'),
    luceneConditionalLimit = 1000;

var formatDate = function(date) {
  return date.zone(0).format('YYYY-MM-DD');
};

var formatDateRange = function(field, startDate, endDate) {
  var start = formatDate(startDate);
  var end = formatDate(endDate.clone().add(1, 'days'));
  return field + '<date>:[' + start + ' TO ' + end + ']';
};

var collectPatientIds = function(records) {
  return _.map(records.rows, function(row) {
    return row.doc.patient_id;
  });
};

var getFormCode = function(key) {
  return config.get('anc_forms')[key];
};

var fti = function(options, callback) {
  var queryOptions = {
    q: options.q,
    sort: options.sort,
    include_docs: options.include_docs,
    limit: options.limit
  };
  db.fti('data_records', queryOptions, function(err, result) {
    if (err) {
      return callback(err);
    }
    if (!result) {
      result = { total_rows: 0, rows: [] };
    } else if (!result.rows) {
      result.rows = [];
    }
    callback(null, result);
  });
};

var ftiWithPatientIds = function(options, callback) {
  if (options.patientIds) {
    if (options.patientIds.length === 0) {
      return callback(null, { total_rows: 0, rows: [] });
    }
    // lucene allows a maximum of 1024 boolean conditions per query
    var chunks = chunk(options.patientIds, luceneConditionalLimit);
    async.reduce(chunks, { rows: [], total_rows: 0 }, function(memo, ids, callback) {
      var queryOptions = {
        q: options.q + ' AND patient_id:(' + ids.join(' OR ') + ')',
        include_docs: options.include_docs
      };
      fti(queryOptions, function(err, result) {
        if (err) {
          return callback(err);
        }
        callback(null, {
          rows: memo.rows.concat(result.rows),
          total_rows: memo.total_rows + result.total_rows
        });
      });
    }, callback);
  } else {
    fti(options, callback);
  }
};

var getHighRisk = function(options, callback) {
  if (!options || !options.patientIds || !options.patientIds.length) {
    return callback(null, []);
  }
  options.include_docs = true;
  options.q = 'form:' + getFormCode('flag');
  ftiWithPatientIds(options, callback);
};

var chunk = function(items, size) {
  var chunks = [];
  for (var i = 0, j = items.length; i < j; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

module.exports = {

  getFormCode: getFormCode,
  fti: fti,
  formatDateRange: formatDateRange,

  getAllRegistrations: function(options, callback) {
    var startDate = options.startDate;
    var endDate = options.endDate;
    if (!startDate || !endDate) {
      startDate = moment().subtract(options.maxWeeksPregnant || 42, 'weeks');
      endDate = moment().subtract(options.minWeeksPregnant || 0, 'weeks');
    }
    var query = 'errors<int>:0 ' +
      'AND form:("' + getFormCode('registration') + '" OR "' + getFormCode('registrationLmp') + '") ' +
      'AND ' + formatDateRange('expected_date', startDate, endDate);
    if (options.district) {
      query += ' AND district:"' + options.district + '"';
    }
    ftiWithPatientIds({
      q: query,
      patientIds: options.patientIds,
      include_docs: true
    }, callback);
  },

  getDeliveries: function(options, callback) {
    if (!callback) {
      callback = options;
      options = {};
    }
    options.q = 'form:' + getFormCode('delivery');
    if (options.startDate && options.endDate) {
      options.q += ' AND ' + formatDateRange('reported_date', options.startDate, options.endDate);
    }
    if (options.district) {
      options.q += ' AND district:"' + options.district + '"';
    }
    ftiWithPatientIds(options, callback);
  },

  getBirthPatientIds: function(options, callback) {
    options.minWeeksPregnant = 42;
    options.maxWeeksPregnant = options.maxWeeksPregnant || 10000;
    module.exports.getAllRegistrations(options, function(err, registrations) {
      if (err) {
        return callback(err);
      }
      options.include_docs = true;
      module.exports.getDeliveries(options, function(err, deliveries) {
        if (err) {
          return callback(err);
        }
        callback(null, _.union(
          collectPatientIds(deliveries),
          collectPatientIds(registrations)
        ));
      });
    });
  },

  rejectDeliveries: function(objects, callback) {
    if (!objects.length) {
      return callback(null, []);
    }
    module.exports.getDeliveries({ 
      patientIds: _.pluck(objects, 'patient_id'),
      include_docs: true
    }, function(err, deliveries) {
      if (err) {
        return callback(err);
      }
      var undelivered = _.reject(objects, function(object) {
        return _.some(deliveries.rows, function(delivery) {
          return delivery.doc.patient_id === object.patient_id;
        });
      });
      callback(null, undelivered);
    });
  },

  getVisits: function(options, callback) {
    if (!options || !options.patientIds || !options.patientIds.length) {
      return callback(null, []);
    }
    var query = 'form:' + getFormCode('visit');
    if (options.startDate) {
      query += ' AND ' + formatDateRange(
        'reported_date', options.startDate, options.endDate || moment().add(2, 'days')
      );
    }
    ftiWithPatientIds({ q: query, include_docs: true, patientIds: options.patientIds }, callback);
  },


  getWeeksPregnant: function(doc) {
    if (doc.form === 'R') {
      return {
        number: moment().diff(moment(doc.reported_date), 'weeks'),
        approximate: true
      };
    }
    return {
      number: moment().diff(moment(doc.lmp_date), 'weeks') - 2
    };
  },

  getEDD: function(doc) {
    if (doc.form === 'R') {
      return {
        date: moment(doc.reported_date).add(40, 'weeks'),
        approximate: true
      };
    }
    return {
      date: moment(doc.lmp_date).add(42, 'weeks')
    };
  },

  injectVisits: function(objects, callback) {
    var patientIds = _.pluck(objects, 'patient_id');
    module.exports.getVisits({ patientIds: patientIds }, function(err, visits) {
      if (err) {
        return callback(err);
      }
      var count = _.countBy(visits.rows, function(visit) {
        return visit.doc.patient_id;
      });
      _.each(objects, function(object) {
        object.visits = count[object.patient_id] || 0;
      });
      callback(null, objects);
    });
  },

  injectRisk: function(objects, callback) {
    var patientIds = _.pluck(objects, 'patient_id');
    getHighRisk({ patientIds: patientIds }, function(err, risks) {
      if (err) {
        return callback(err);
      }
      _.each(risks.rows, function(risk) {
        var object = _.findWhere(objects, { patient_id: risk.doc.patient_id });
        if (object) {
          object.high_risk = true;
        }
      });
      callback(null, objects);
    });
  },

  // exposed for testing
  setup: function(limit) {
    luceneConditionalLimit = limit;
  }

};