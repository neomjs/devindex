import ContentSectionStore from '../../store/ContentSections.mjs';
import ContentStore        from '../../store/Content.mjs';
import StateProvider       from '../../../../node_modules/neo.mjs/src/state/Provider.mjs';

/**
 * @class DevIndex.view.learn.MainContainerStateProvider
 * @extends Neo.state.Provider
 */
class MainContainerStateProvider extends StateProvider {
    static config = {
        /**
         * @member {String} className='DevIndex.view.learn.MainContainerStateProvider'
         * @protected
         */
        className: 'DevIndex.view.learn.MainContainerStateProvider',
        /**
         * @member {Object} data
         */
        data: {
            /**
             * @member {String|null} data.contentPath=null
             */
            /*
             * Origin-absolute ON PURPOSE — do not "restore" the `Neo.config.basePath +` prefix.
             *
             * `basePath` is `../../`, a DOCUMENT-relative path, and this value is consumed inside a
             * Web Worker. Because `workerBasePath` points at `node_modules/neo.mjs/src/worker/`, a
             * relative specifier resolved there climbs to `/node_modules/neo.mjs/` instead of the
             * repository root — so content was fetched from inside the engine package. That failure
             * is not symmetric: `learn/Introduction.md` does not exist there and 404s loudly, while
             * `learn/tree.json` DOES exist there and returns the engine's own portal tree with a 200.
             *
             * A leading slash sidesteps the whole question: it ignores whatever base resolves it, so
             * the worker and the document agree by construction rather than by coincidence. Inside
             * the engine's repository they agree anyway, which is why this never surfaced there.
             *
             * The bound this carries: it assumes the app is served from the origin root. Deploying
             * under a sub-path (a GitHub Pages project site at `/devindex/`) makes this one string
             * to update — and that belongs to the deployment-target decision, not here.
             */
            contentPath: '/learn/',
            /**
             * @member {Number|null} data.countPages=null
             */
            countPages: null,
            /**
             * @member {Number|null} data.countSections=null
             */
            countSections: null,
            /**
             * The record which gets shown as the content page
             * @member {Object} data.currentPageRecord=null
             */
            currentPageRecord: null,
            /**
             * The record which gets shown as the content page
             * @member {Object} data.nextPageRecord=null
             */
            nextPageRecord: null,
            /**
             * The record which gets shown as the content page
             * @member {Object} data.previousPageRecord=null
             */
            previousPageRecord: null
        },
        /**
         * @member {Object} stores
         */
        stores: {
            sections: {
                module: ContentSectionStore
            },
            tree: {
                module: ContentStore
            }
        }
    }

    /**
     * @param {String} key
     * @param {*} value
     * @param {*} oldValue
     */
    onDataPropertyChange(key, value, oldValue) {
        super.onDataPropertyChange(key, value, oldValue);

        let me = this;

        switch (key) {
            case 'countSections': {
                if (value < 1) {
                    me.component.getReference('page-sections-container')?.toggleCls('neo-expanded', false)
                }

                break
            }

            case 'currentPageRecord': {
                let {data}             = me,
                    {countPages}       = data,
                    store              = me.getStore('tree'),
                    index              = store.indexOf(value),
                    nextPageRecord     = null,
                    nextPageText       = null,
                    previousPageRecord = null,
                    previousPageText   = null,
                    i, record;

                // the logic assumes that the tree store is sorted
                for (i=index-1; i >= 0; i--) {
                    record = store.getAt(i);

                    if (record.isLeaf && !me.recordIsHidden(record, store)) {
                        previousPageRecord = record;
                        break
                    }
                }

                me.setData({previousPageText, previousPageRecord});

                // the logic assumes that the tree store is sorted
                for (i=index+1; i < countPages; i++) {
                    record = store.getAt(i);

                    if (record.isLeaf && !me.recordIsHidden(record, store)) {
                        nextPageRecord = record;
                        break
                    }
                }

                me.setData({nextPageText, nextPageRecord});

                me.component.getReference('sidenav-container')?.toggleCls('neo-expanded', false)

                break
            }
        }
    }

    /**
     * We need to check the parent-node chain inside the tree.
     * => Any hidden parent-node results in a hidden record.
     * @param {Object} record
     * @param {Neo.data.Store} store
     * @returns {Boolean}
     */
    recordIsHidden(record, store) {
        if (record.hidden) {
            return true
        }

        if (record.parentId !== null) {
            return this.recordIsHidden(store.get(record.parentId), store)
        }

        return false
    }
}

export default Neo.setupClass(MainContainerStateProvider);
