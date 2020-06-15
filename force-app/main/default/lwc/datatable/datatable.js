import { LightningElement, api, wire } from 'lwc';
import { getObjectInfo } from 'lightning/uiObjectInfoApi';

import * as tableService from 'c/tableService'; // Data, columns, mass update

// Toast and Errors
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { reduceErrors, createSetFromDelimitedString } from 'c/utils';

const MAX_ROW_SELECTION = 200;

export default class Datatable extends LightningElement {
    /**
     * Public props
     */
    @api recordId;
    @api
    get keyField() {
        return this._keyField || 'Id';
    }
    set keyField(value = 'Id') {
        this._keyField = value;
    }
    @api title;
    @api showRecordCount;

    // SOQL
    @api queryString;
    @api isRecordBind;

    // Misc
    @api columnWidthsMode = 'auto'; // override salesforce default
    @api showRefreshButton = false;

    // Sorting
    @api sortedBy;
    @api sortedDirection = 'asc';
    @api
    get sortableFields() {
        return this._sortableFields;
    }
    set sortableFields(value = '') {
        this._sortableFields = createSetFromDelimitedString(value, ',');
    }

    // Row selections
    @api selectedRows = [];
    @api
    get checkboxType() {
        return this._checkboxType;
    }
    set checkboxType(value = 'None') {
        switch (value) {
            case 'Multi':
                this.maxRowSelection = MAX_ROW_SELECTION;
                this.isHideCheckbox = false;
                break;
            case 'Single':
                this.maxRowSelection = 1;
                this.isHideCheckbox = false;
                break;
            default:
                this.isHideCheckbox = true;
                break;
        }
    }

    // In-line editing
    @api
    get editableFields() {
        return this._editableFields;
    }
    set editableFields(value = '') {
        this._editableFields = createSetFromDelimitedString(value, ',');
    }

    /**
     * Template props
     */

    showSpinner = false;
    isHideCheckbox = true;
    maxRowSelection = MAX_ROW_SELECTION;

    tableData = [];
    tableColumns = [];
    draftValues = []; // this is to feed into the datatable to clear stuff out
    saveErrors = {};

    /**
     * Template getters
     */

    get recordCount() {
        return this.tableData ? this.tableData.length : 0;
    }

    get hasActions() {
        // More in the future
        return this.showRefreshButton;
    }

    /**
     * Public Methods
     */

    @api
    async reloadTable() {
        const data = await this.fetchTableService();
        this._setTableData(data.tableData, true);
    }

    @api
    initializeTable(objectApiName, columns, data) {
        this._objectApiName = objectApiName;
        this._setTableColumns(columns);
        this._setTableData(data);
    }

    /**
     * Private props
     */

    _isRendered;
    _messageBroker;

    // For public getters
    _keyField;
    _checkboxType;
    _sortableFields;
    _editableFields;

    // In-line Edit
    _draftValuesMap = new Map();
    _objectApiName;
    _objectInfo;

    // For future if object info data is needed
    @wire(getObjectInfo, { objectApiName: '$_objectApiName' })
    wiredObjectInfo({ error, data }) {
        if (data) {
            this._objectInfo = data;
        } else if (error) {
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'getObjectInfo error',
                    message: reduceErrors(error)[0],
                    variant: 'error'
                })
            );
        }
    }

    async connectedCallback() {
        if (this.isRecordBind || this.queryString) {
            const data = await this.fetchTableService();
            console.log(JSON.parse(JSON.stringify(data)));
            this._objectApiName = data.objectApiName;
            this._setTableColumns(data.tableColumns);
            this._setTableData(data.tableData, false);
        }
    }

    renderedCallback() {
        if (this._isRendered) {
            return;
        }
        this._isRendered = true;
        this._messageBroker = this.template.querySelector('c-message-broker');
    }

    async fetchTableService() {
        let results = {};
        const finalQueryString = this.isRecordBind
            ? this.queryString.replace('recordId', "'" + this.recordId + "'")
            : this.queryString;

        this.showSpinner = true;
        try {
            results = await tableService.getTableRequest({ queryString: finalQueryString });
        } catch (error) {
            this._messageBroker.notifySingleError('fetchTableService error', error);
        } finally {
            this.showSpinner = false;
        }
        return results;
    }

    /* Event Handlers */

    handleRowSelection(event) {
        this.selectedRows = event.detail.selectedRows;
        this._notifyPublicEvent('rowselection');
    }

    handleColumnSorting(event) {
        this._updateColumnSorting(event.detail.fieldName, event.detail.sortDirection);
    }

    handleCellChange(event) {
        // This function is needed for handling custom data types to unify draftValue changes
        event.detail.draftValues.forEach(draft => {
            if (!this._draftValuesMap.has(draft[this.keyField])) {
                this._draftValuesMap.set(draft[this.keyField], draft);
            }
            const changedData = this._draftValuesMap.get(draft[this.keyField]);
            this._draftValuesMap.set(draft[this.keyField], { ...changedData, ...draft });
        });
        if (this._draftValuesMap.size > 0) {
            this.draftValues = [...this._draftValuesMap.values()];
        }
    }

    handleCancel() {
        // do not prevent default, but tell every single draft row to clear itself
        this._clearDraftValues([...this._draftValuesMap.keys()]);
    }

    async handleSave(event) {
        // Provides data to paint errors if needed, luckily draftValues come in ordered by row number
        const rowKeyToRowNumberMap = new Map(
            event.detail.draftValues.map(draft => [
                draft[this.keyField],
                this.tableData.findIndex(data => draft[this.keyField] === data[this.keyField]) + 1
            ])
        );
        // On partial save rows, this helps signal which rows succeeded by clearing them out
        this.draftValues = event.detail.draftValues;
        this.showSpinner = true;

        const saveResults = await tableService.updateDraftValues(this.draftValues, rowKeyToRowNumberMap);

        if (saveResults.errors.rows && Object.keys(saveResults.errors.rows).length) {
            this.saveErrors = saveResults.errors;
        }
        if (saveResults.success && saveResults.success.length) {
            const cleanRowKey = this.keyField === 'Id' ? 'id' : this.keyField; // LDS response lowercases this
            const successRowKeys = saveResults.success.map(recordInput => recordInput[cleanRowKey]);
            await this.reloadTable();
            this._clearDraftValues(successRowKeys);
        }
        // In case there are only error rows
        this.showSpinner = false;
    }

    /**
     * Private functions
     */

    _setTableColumns(tableColumns) {
        if (!tableColumns || !tableColumns.length) {
            return;
        }
        let finalColumns = [];
        for (let col of tableColumns) {
            // Sorting
            if (this._sortableFields && this._sortableFields.size) {
                // If parent fields require sorting, use _ in place of . for the fieldName.
                if (this._sortableFields.has(col.fieldName)) {
                    col.sortable = true;
                }
            }
            // Inline edit
            if (this._editableFields && this._editableFields.size) {
                col.editable = this._editableFields.has(col.fieldName);
            }
            finalColumns.push(col);
        }
        this.tableColumns = finalColumns;
        this._notifyPublicEvent('columnsload');
    }

    _setTableData(tableData, isRefresh) {
        if (!tableData || !tableData.length) {
            return;
        }
        // First Paint - no sort
        if (!isRefresh && !this.sortedBy) {
            this.tableData = tableData;
        }
        // First Paint - has sort
        if (!isRefresh && this.sortedBy) {
            this._sortData(this.sortedBy, this.sortedDirection, tableData);
        }
        // Refresh should respect whatever is in the UI
        if (isRefresh) {
            this.tableData = this.tableData.map(uiRow =>
                tableData.find(serverRow => uiRow[this.keyField] === serverRow[this.keyField])
            );
        }
        this._notifyPublicEvent('rowsload');
    }

    _updateColumnSorting(fieldName, sortDirection) {
        this.sortedBy = fieldName;
        this.sortedDirection = sortDirection;
        this._sortData(fieldName, sortDirection, this.tableData);
    }

    _sortData(fieldName, sortDirection, unsortedData) {
        const dataToSort = JSON.parse(JSON.stringify(unsortedData));
        const reverse = sortDirection !== 'asc';
        this.tableData = dataToSort.sort(this._sortBy(fieldName, reverse));
    }

    _sortBy(field, reverse, primer) {
        const key = primer
            ? function(x) {
                  return primer(x[field]);
              }
            : function(x) {
                  return x[field];
              };
        // checks if the two rows should switch places
        reverse = !reverse ? 1 : -1;
        return function(a, b) {
            return (a = key(a) ? key(a) : ''), (b = key(b) ? key(b) : ''), reverse * ((a > b) - (b > a));
        };
    }

    _clearDraftValues(rowKeysToNull) {
        // For save of only a subset of the total rows
        this.draftValues = this.draftValues.filter(draft => !rowKeysToNull.includes(draft[this.keyField]));
        rowKeysToNull.forEach(key => {
            this._draftValuesMap.delete(key);
        });
        // Removes both table and row errors from `lightning-datatable`
        if (this._draftValuesMap.size === 0 && this.draftValues.length === 0) {
            this.saveErrors = [];
        }
    }

    _notifyPublicEvent(eventName) {
        switch (eventName) {
            case 'columnsload': {
                this.dispatchEvent(
                    new CustomEvent('columnsload', {
                        detail: { tableColumns: this.tableColumns },
                        bubbles: true,
                        composed: true
                    })
                );
                break;
            }
            case 'rowsload': {
                this.dispatchEvent(
                    new CustomEvent('rowsload', {
                        detail: { tableData: this.tableData },
                        bubbles: true,
                        composed: true
                    })
                );
                break;
            }
            case 'rowselection': {
                this.dispatchEvent(
                    new CustomEvent('rowselection', {
                        detail: { selectedRows: this.selectedRows },
                        bubbles: true,
                        composed: true
                    })
                );
                break;
            }
            default:
            // nothing
        }
    }
}
