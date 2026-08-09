class RoutingContext {
    private triedUpstreams = new Set<string>();


    private key(vendorId: number, vendorModelName: string): string {
        return `${vendorId}:${vendorModelName}`;
    }


    hasTried(vendorId: number, vendorModelName: string): boolean {
        return this.triedUpstreams.has(this.key(vendorId, vendorModelName));
    }


    markTried(vendorId: number, vendorModelName: string): void {
        this.triedUpstreams.add(this.key(vendorId, vendorModelName));
    }
}

export default RoutingContext;
