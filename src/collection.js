'use strict';
const mongodb = require("mongodb");

class Collection {
    constructor(name) {
        this.name = name;
    }
}

class Hash {
    constructor(id) {

        Object.defineProperty(this, '$id', {value: id || new mongodb.ObjectID().toString()});
        Object.defineProperty(this, '$ref', {value: {type: '__hash__', id: this.$id}});
        Object.defineProperty(this, '$resolved', {value: false, writable: true});
        Object.defineProperty(this, '$new', {value: true, writable: true});
    }

    static async $resolve(id) {
        const h = new Hash(id);
        if (!!id) {
            await h.$resolve().catch(err => {
                console.error('Collection object resolve failed %s', err.message || err);
            });
        }
        return h;
    }

    async $resolve() {
        if (this.$resolved) {
            console.error("hash object $resolved %s", this.$resolved);
            return;
        }
        const data = await $redis.command('HGETALL', this.$id);
        if (!!data) {
            this.$new = false;

            for (let i in data) {
                if (typeof data[i] === 'object') {
                    if (data[i].type === '__hash__') {
                        this[i] = await Hash.$resolve(data[i].id);
                        continue;
                    }
                    if (data[i].type === '__array__') {
                        this[i] = await LArray.$resolve(data[i].id);
                        continue;
                    }
                }
                this[i] = data[i];
            }
        }
        this.$resolved = true;
        return this;
    }

    async $incrby(incrs, rate = 1, floor = {}) {

        const changed = {};
        let success = true;
        for (let i in incrs) {
            changed[i] = rate * parseInt(incrs[i]);
            this[i] = await $redis.command('HINCRBY', this.$id, i, changed[i]);
            if (this[i] < floor[i]) {
                success = false;
                break;
            }
        }
        if (!success) {
            await this.$incrby(changed, -1);
            return;
        }

        return changed;
    }

    async $mset(object) {
        if (!this.$resolved) {
            await this.$resolve();
        }
        for (let i in object) {
            await this.$set(i, object[i]);
        }
        return this;
    }

    async $set(k, v) {
        if (!this.$resolved) {
            await this.$resolve();
        }

        if (this[k] && (this[k] instanceof Hash || this[k] instanceof LArray)) {
            await this[k].$remove(k);
        }

        if (v && (v instanceof Hash || v instanceof LArray)) {
            this[k] = await v.$referenceof(this.$id);
            await $redis.command('HSET', this.$id, k, JSON.stringify(this[k].$ref));
            return this;
        }

        if (v && typeof v.type === 'string' && v.id !== 'undefined') {
            if (v.type === '__hash__') {
                this[k] = await Hash.$resolve(v.id);
                await this[k].$referenceof(this.$id);
                await $redis.command('HSET', this.$id, k, JSON.stringify(this[k].$ref));
                return this;
            }
            if (v.type === '__array__') {
                this[k] = await LArray.$resolve(v.id);
                await this[k].$referenceof(this.$id);
                await $redis.command('HSET', this.$id, k, JSON.stringify(this[k].$ref));
                return this;
            }
        }
        if (typeof v === 'object' && v !== null) {
            if (v instanceof Array) {
                this[k] = new LArray();
                await this[k].$push(...v);
                await this[k].$referenceof(this.$id);
                await $redis.command('HSET', this.$id, k, JSON.stringify(this[k].$ref));
                return this;
            }

            this[k] = new Hash();
            await this[k].$mset(v);
            await this[k].$referenceof(this.$id);
            await $redis.command('HSET', this.$id, k, JSON.stringify(this[k].$ref));
            return this;
        }

        this[k] = v;
        await $redis.command('HSET', this.$id, k, v);
        return this;
    }

    async $referenceof(id) {
        await $redis.command('LPUSH', `reference.${this.$id}`, id);
        return this;
    }

    async $remove(k) {
        if (!this.$resolved) {
            await this.$resolve();
        }
        if (this[k] && (this[k] instanceof Hash || this[k] instanceof LArray)) {
            await this[k].$release(this.$id);
        }
        delete this[k];
        return this;
    }

    async $release(id) {
        if (!this.$resolved) {
            await this.$resolve();
        }

        if (id) {
            await $redis.command('LREM', `reference.${this.$id}`, 0, id);
        }

        for (let i in this) {
            await this.$remove(i);
        }

        const ref = await $redis.command('LLEN', `reference.${this.$id}`);
        if (ref === 0) {
            await $redis.command('DEL', this.$id);
        }
    }
}

class LArray extends Array {
    constructor(id) {
        super();

        Object.defineProperty(this, '$id', {value: id || new mongodb.ObjectID().toString()});
        Object.defineProperty(this, '$ref', {value: {type: '__array__', id: this.$id}});
        Object.defineProperty(this, '$resolved', {value: false, writable: true});
        Object.defineProperty(this, '$new', {value: true, writable: true});
    }

    static async $resolve(id) {
        const l = new LArray(id);
        await l.$resolve().catch(err => {
            console.error('Collection object resolve failed %s', err.message || err);
        });
        return l;
    }

    async $resolve() {
        const data = await $redis.command('LRANGE', this.$id, 0, -1);
        if (data) {
            this.$new = false;

            for (let i in data) {
                if (typeof data[i] === 'object') {
                    if (data[i].type === '__hash__') {
                        this.push(await Hash.$resolve(data[i].id));
                        continue;
                    }
                    if (data[i].type === '__array__') {
                        this.push(await LArray.$resolve(data[i].id));
                        continue;
                    }
                }
                this.push(data[i]);
            }
        }
        this.$resolved = true;
    }

    async $push() {
        if (!this.$resolved) {
            await this.$resolve();
        }
        const args = [].slice.call(arguments);

        const cmds = ['LPUSH', this.$id];
        for (let i in args) {
            let obj = args[i];
            switch (obj.type) {
                case '__hash__':
                    obj = await Hash.$resolve(obj.id);
                    break;
                case '__array__':
                    obj = await LArray.$resolve(obj.id);
                    break;
                default:
                    if (typeof obj === 'object') {
                        if (obj instanceof Array) {
                            const a = new LArray();
                            await a.$push(...obj);
                            obj = a;
                        } else {
                            const b = new Hash();
                            await b.$mset(obj);
                            obj = b;
                        }
                    }
                    break;
            }

            if (obj instanceof Hash || obj instanceof LArray) {
                this.push(await obj.$referenceof(this.$id));
                cmds.push(JSON.stringify(obj.$ref));
                continue;
            }
            this.push(obj);
        }
        if (cmds.length > 2) {
            await $redis.command(...cmds);
        }
        return this;
    }

    async $shift() {
        if (!this.$resolved) {
            await this.$resolve();
        }

        const head = this.shift();
        if (head && (head instanceof Hash || head instanceof LArray)) {
            await head.$release(this.$id);
        }
        await $redis.command('LPOP', this.$id);
        return head;
    }

    async $release(id) {
        if (!this.$resolved) {
            await this.$resolve();
        }
        if (id) {
            await $redis.command('LREM', `reference.${this.$id}`, 0, id);
        }
        for (let i in this) {
            if (this[i] instanceof Hash || this[i] instanceof LArray) {
                await this[i].$release(this.$id);
            }
        }
        return this;
    }

    async $referenceof(id) {
        await $redis.command('LPUSH', `reference.${this.$id}`, id);
        return this;
    }
}


module.exports = {
    Hash, LArray, Collection
};