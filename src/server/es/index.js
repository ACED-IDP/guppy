import { Client } from '@elastic/elasticsearch';
import _ from 'lodash';
import config from '../config';
import * as esFilter from './filter';
import * as esAggregator from './aggs';
import log from '../logger';
import { SCROLL_PAGE_SIZE } from './const';
import CodedError from '../utils/error';

class ES {
  constructor(esConfig = config.esConfig) {
    this.config = esConfig;
    this.client = new Client({
      node: this.config.host,
      // log: 'trace'
    });
    this.client.ping({}, (error) => {
      if (error) {
        log.error(`[ES] elasticsearch cluster at ${this.config.host} is down!`);
      } else {
        log.info(`[ES] connected to elasticsearch at ${this.config.host}.`);
        this.connected = true;
      }
    });
  }

  async _getESFieldsTypes(esIndex, esType) {
    return this.client.indices.getMapping({
      index: esIndex,
      type: esType,
    }).then((resp) => {
      const esIndexAlias = Object.keys(resp.body)[0];
      const mappingObj = resp.body[esIndexAlias].mappings[esType].properties;
      const fieldTypes = Object.keys(mappingObj).reduce((acc, field) => {
        const esFieldType = mappingObj[field].type;
        acc[field] = esFieldType;
        return acc;
      }, {});
      return fieldTypes;
    }, (err) => {
      console.trace(err.message); // eslint-disable-line no-console
    });
  }

  /**
   * Query ES data (search API) by index, type, and queryBody
   * See https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/api-reference.html#_search
   * @param {string} esIndex
   * @param {string} esType
   * @param {object} queryBody
   */
  async query(esIndex, esType, queryBody) {
    const validatedQueryBody = {};
    Object.keys(queryBody).forEach((key) => {
      if (typeof queryBody[key] !== 'undefined' && queryBody[key] !== null) {
        validatedQueryBody[key] = queryBody[key];
      }
    });
    log.info('[ES.query] query body: ', JSON.stringify(validatedQueryBody, null, 4));
    return this.client.search({
      index: esIndex,
      type: esType,
      body: validatedQueryBody,
    }).then(resp => resp.body, (err) => {
      log.error('[ES.query] error when query');
      console.trace(err.message); // eslint-disable-line no-console
    });
  }

  /**
   * Fetch elastic search data using scroll API
   * See https://www.elastic.co/guide/en/elasticsearch/reference/current/search-request-scroll.html
   * @param {string} esIndex
   * @param {string} esType
   * @param {Object} argument - arg object for filter, fields, and sort
   */
  async scrollQuery(esIndex, esType, {
    filter,
    fields,
    sort,
  }) {
    if (!esIndex || !esType) {
      throw new CodedError(
        400,
        'Invalid es index or es type name',
      );
    }
    const fieldsNotBelong = _.difference(fields, this.getESFields(esIndex).fields);
    if (fieldsNotBelong.length > 0) {
      throw new CodedError(
        400,
        `Invalid fields: "${fieldsNotBelong.join('", "')}"`,
      );
    }
    const validatedQueryBody = filter ? { query: filter } : {};
    log.debug('[ES.scrollQuery] scroll query body: ', JSON.stringify(validatedQueryBody, null, 4));

    let currentBatch;
    let scrollID;
    let totalData = [];
    let batchSize = 0;

    while (!currentBatch || batchSize > 0) {
      if (typeof scrollID === 'undefined') { // first batch
        const res = await this.client.search({ // eslint-disable-line no-await-in-loop
          index: esIndex,
          type: esType,
          body: validatedQueryBody,
          scroll: '1m',
          size: SCROLL_PAGE_SIZE,
          _source: fields,
          sort,
        }).then(resp => resp, (err) => {
          log.error('[ES.query] error when query');
          console.trace(err.message); // eslint-disable-line no-console
        });
        currentBatch = res.body;
        log.debug('[ES scrollQuery] created scroll');
      } else { // following batches
        const res = await this.client.scroll({ // eslint-disable-line no-await-in-loop
          scroll_id: scrollID,
          scroll: '1m',
        });
        currentBatch = res.body;
      }

      // merge fetched batches
      log.debug('[ES scrollQuery] get batch size = ', batchSize, ' merging...');
      scrollID = currentBatch._scroll_id;
      batchSize = currentBatch.hits.hits.length;

      // TODO: change it to streaming
      totalData = totalData.concat(currentBatch.hits.hits.map(item => item._source));
    }

    log.debug('[ES scrollQuery] end scrolling');
    await this.client.clearScroll({
      scroll_id: scrollID,
    });
    log.debug('[ES scrollQuery] scroll cleaned');
    return totalData;
  }

  async initialize() {
    this.fieldTypes = {};
    log.info('[ES.initialize] getting mapping from elasticsearch...');
    const promiseList = this.config.indices
      .map(cfg => this._getESFieldsTypes(cfg.index, cfg.type)
        .then(res => ({ index: cfg.index, fieldTypes: res })));
    const resultList = await Promise.all(promiseList);
    log.info('[ES.initialize] got mapping from elasticsearch');
    resultList.forEach((res) => {
      this.fieldTypes[res.index] = res.fieldTypes;
    });
    log.debug('[ES.initialize]', JSON.stringify(this.fieldTypes, null, 4));
    return this.fieldTypes;
  }

  /**
   * Get ES fields' mapping type by es index name
   * Returns an object of field=>type mapping
   * @param {string} esIndex
   */
  getESFieldTypeMappingByIndex(esIndex) {
    return this.fieldTypes[esIndex];
  }

  /**
   * Get fields by esIndex
   * If esIndex is not set, return all fields grouped by index and types.
   * @param {string} esIndex
   */
  getESFields(esIndex) {
    const res = {};
    this.config.indices.forEach((cfg) => {
      res[cfg.index] = {
        index: cfg.index,
        type: cfg.type,
        fields: Object.keys(this.fieldTypes[cfg.index]),
      };
    });
    if (typeof esIndex === 'undefined') {
      return res;
    }
    return res[esIndex];
  }

  /**
   * Get es index by es type
   * Throw 400 error if there's no existing es type
   * @param {string} esType
   */
  getESIndexByType(esType) {
    const index = this.config.indices.find(i => i.type === esType);
    if (index) return index.index;
    throw new CodedError(
      400,
      `Invalid es type: "${esType}"`,
    );
  }

  getCount(esIndex, esType, filter) {
    return esFilter.getCount(this, esIndex, esType, filter);
  }

  getData({
    esIndex, esType, fields, filter, sort, offset, size,
  }) {
    return esFilter.getData(
      {
        esInstance: this,
        esIndex,
        esType,
      },
      {
        fields, filter, sort, offset, size,
      },
    );
  }

  downloadData({
    esIndex, esType, fields, filter, sort,
  }) {
    return esFilter.getDataUsingScroll(
      {
        esInstance: this,
        esIndex,
        esType,
      },
      {
        fields, filter, sort,
      },
    );
  }

  numericAggregation({
    esIndex,
    esType,
    filter,
    field,
    rangeStart,
    rangeEnd,
    rangeStep,
    binCount,
    filterSelf,
  }) {
    return esAggregator.numericAggregation(
      {
        esInstance: this,
        esIndex,
        esType,
      },
      {
        esIndex,
        esType,
        filter,
        field,
        rangeStart,
        rangeEnd,
        rangeStep,
        binCount,
        filterSelf,
      },
    );
  }

  textAggregation({
    esIndex,
    esType,
    filter,
    field,
    filterSelf,
  }) {
    return esAggregator.textAggregation(
      {
        esInstance: this,
        esIndex,
        esType,
      },
      {
        filter,
        field,
        filterSelf,
      },
    );
  }
}

const es = new ES();

export default es;