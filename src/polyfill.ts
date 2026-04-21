declare global {
    namespace NodeJS {
        interface Process {
            pkg?: any;
        }
    }
}

if (typeof Intl.Segmenter === "undefined" || (typeof process !== "undefined" && process.pkg)) {
    Object.defineProperty(Intl, 'Segmenter', {
        value: class {
            constructor() {}
            segment(str: string) {
                const segments = [];
                for (let i = 0; i < str.length; i++) {
                    segments.push({ segment: str[i], index: i, input: str });
                }
                return segments;
            }
        },
        writable: true,
        configurable: true
    });
}
