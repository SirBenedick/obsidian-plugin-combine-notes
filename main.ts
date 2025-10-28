import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFolder, TFile, FuzzySuggestModal, FuzzyMatch, MarkdownRenderer } from 'obsidian';

// --- MODAL TO SELECT A FOLDER ---
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    plugin: CombineNotesPlugin; 

    constructor(app: App, plugin: CombineNotesPlugin) { 
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Select a folder to combine notes from");
    }

    // Get all folders in the vault
    getItems(): TFolder[] {
        return this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
    }

    // Get the text to display for each folder
    getItemText(folder: TFolder): string {
        return folder.path;
    }

    // What to do when a folder is chosen
    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.plugin.combineNotes(folder);
    }

    // Preselect the parent folder of the currently active file
    onOpen() {
        super.onOpen();
        
        if (this.plugin.settings.preselectParentFolder) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && activeFile.parent) {
                // Set the input value to the parent folder path
                this.inputEl.value = activeFile.parent.path;
                // Trigger input event to update the suggestions
                this.inputEl.dispatchEvent(new Event('input'));
            }
        }

        // Add smart backspace functionality
        this.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Backspace' && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
                const input = this.inputEl;
                const cursorPos = input.selectionStart || 0;
                const value = input.value;
                
                // Only do smart delete if cursor is at the end and there's no selection
                if (cursorPos === value.length && input.selectionStart === input.selectionEnd && value.length > 0) {
                    evt.preventDefault();
                    
                    // Check if last character is a slash
                    if (value.endsWith('/')) {
                        // Just remove the trailing slash
                        input.value = value.substring(0, value.length - 1);
                    } else {
                        // Find the last slash before the cursor
                        const lastSlashIndex = value.lastIndexOf('/');
                        
                        if (lastSlashIndex >= 0) {
                            // Delete everything after the last slash, keep the slash
                            input.value = value.substring(0, lastSlashIndex + 1);
                        } else {
                            // If no slash found, clear everything
                            input.value = '';
                        }
                    }
                    
                    // Trigger input event to update suggestions
                    input.dispatchEvent(new Event('input'));
                }
            }
        });
    }
}


interface CombineNotesPluginSettings {
	outputFolder: string;
	preselectParentFolder: boolean;
}

const DEFAULT_SETTINGS: CombineNotesPluginSettings = {
	outputFolder: 'combined_notes',
	preselectParentFolder: true
}

export default class CombineNotesPlugin extends Plugin {
	settings: CombineNotesPluginSettings;

	async onload() {
		await this.loadSettings();



		this.addCommand({
			id: 'combine-notes-with-preview',
			name: 'Show preview',
			callback: () => {
				new FolderSuggestModalForPreview(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'combine-notes-copy-direct',
			name: 'Copy to clipboard',
			callback: () => {
				new FolderSuggestModalForDirectCopy(this.app, this).open();
			}
		});


        this.addCommand({
            id: 'combine-notes-in-folder',
            name: 'Save to file',
            callback: () => {
                // Open the modal to ask user which folder
                new FolderSuggestModal(this.app, this).open();
            }
        });


		this.addSettingTab(new SettingsTab(this.app, this)); 

		// Add Right-click folder menu for Combine Notes ---
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                // Only show if the user right-clicked a folder
                if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Combine notes in this folder')
                            .setIcon('documents') 
                            .onClick(async () => {
                                this.combineNotes(file as TFolder);
                            });
                    });
                }
            })
        );

	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

    /**
     * Recursively finds all markdown files within a given folder.
     */
    async getMarkdownFiles(folder: TFolder): Promise<TFile[]> {
        const files: TFile[] = [];

        for (const child of folder.children) {
            if (child instanceof TFolder) {
                // If it's a folder, dive deeper
                files.push(...(await this.getMarkdownFiles(child)));
            } else if (child instanceof TFile && child.extension === 'md') {
                // If it's a markdown file, add it
                files.push(child);
            }
        }
        return files;
    }

	// combineNotes method 
    /**
     * The main logic, translated from your Python script.
     * Gathers all .md files, reads them, and combines them into a new note.
     */
    async combineNotes(folder: TFolder) {
        const outputRootFolder = this.settings.outputFolder;
        
        // 1. Ensure the output folder exists
        try {
            // Try to get the folder
            const existingFolder = this.app.vault.getAbstractFileByPath(outputRootFolder);
            if (!existingFolder || !(existingFolder instanceof TFolder)) {
                // If it doesn't exist or isn't a folder, create it
                await this.app.vault.createFolder(outputRootFolder);
            }
        } catch (e) {
            new Notice(`Error creating output folder: ${e.message}`);
            console.error(e);
            return;
        }

        // 2. Create the timestamped file name
        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0'); // getMonth() is 0-indexed
        const day = now.getDate().toString().padStart(2, '0');
		const time = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
        const timestamp = `${year}-${month}-${day}-${time}`;
        
        // Use folder.name to make the output file identifiable
        const outputFileName = `${outputRootFolder}/${timestamp}_${folder.name}-combined.md`;
        
        new Notice(`Combining notes from "${folder.path}"...`);

        try {
            const allContent: string[] = [];
            const mdFiles = await this.getMarkdownFiles(folder);
            
            // Sort files alphabetically by path, just like the Python script
            mdFiles.sort((a, b) => a.path.localeCompare(b.path));

            if (mdFiles.length === 0) {
                new Notice('No markdown files found in that folder.');
                return;
            }
            
            console.log(`Found ${mdFiles.length} markdown files.`);

            for (const file of mdFiles) {
                // Skip the output file itself if it somehow gets included
                if (file.path === outputFileName) {
                    continue;
                }

                // Get path relative to the *selected folder*
                // This matches your Python script's logic
                // Handle root folder case
                let relativePath = file.path;
                if (folder.path !== '/') {
                    relativePath = file.path.substring(folder.path.length + 1);
                }


                // Read the file content
                const content = await this.app.vault.read(file);

                // Add the header and content
                allContent.push(`------------\n`);
                allContent.push(`# Document: ${relativePath}\n\n`);
                allContent.push(content);
                allContent.push(`\n\n`); // Spacing
            }

            // 4. Create the new combined note
            await this.app.vault.create(outputFileName, allContent.join(''));
            
            new Notice(`Successfully created combined note at:\n${outputFileName}`);

        } catch (e) {
            new Notice(`Error combining notes: ${e.message}`);
            console.error(e);
        }
    }
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class FolderSuggestModalForPreview extends FuzzySuggestModal<TFolder> {
	plugin: CombineNotesPlugin;

	constructor(app: App, plugin: CombineNotesPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("Select a folder to preview combined notes");
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
		new CombineNotesPreviewModal(this.app, folder, this.plugin).open();
	}

	// Preselect the parent folder of the currently active file
	onOpen() {
		super.onOpen();
		
		if (this.plugin.settings.preselectParentFolder) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.parent) {
				// Set the input value to the parent folder path
				this.inputEl.value = activeFile.parent.path;
				// Trigger input event to update the suggestions
				this.inputEl.dispatchEvent(new Event('input'));
			}
		}

		// Add smart backspace functionality
		this.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Backspace' && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
				const input = this.inputEl;
				const cursorPos = input.selectionStart || 0;
				const value = input.value;
				
				// Only do smart delete if cursor is at the end and there's no selection
				if (cursorPos === value.length && input.selectionStart === input.selectionEnd && value.length > 0) {
					evt.preventDefault();
					
					// Check if last character is a slash
					if (value.endsWith('/')) {
						// Just remove the trailing slash
						input.value = value.substring(0, value.length - 1);
					} else {
						// Find the last slash before the cursor
						const lastSlashIndex = value.lastIndexOf('/');
						
						if (lastSlashIndex >= 0) {
							// Delete everything after the last slash, keep the slash
							input.value = value.substring(0, lastSlashIndex + 1);
						} else {
							// If no slash found, clear everything
							input.value = '';
						}
					}
					
					// Trigger input event to update suggestions
					input.dispatchEvent(new Event('input'));
				}
			}
		});
	}
}

class FolderSuggestModalForDirectCopy extends FuzzySuggestModal<TFolder> {
	plugin: CombineNotesPlugin;

	constructor(app: App, plugin: CombineNotesPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("Select a folder to copy combined notes");
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	async onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): Promise<void> {
		try {
			const allContent: string[] = [];
			const mdFiles = await this.getMarkdownFiles(folder);

			mdFiles.sort((a, b) => a.path.localeCompare(b.path));

			if (mdFiles.length === 0) {
				new Notice('No markdown files found in that folder.');
				return;
			}

			for (const file of mdFiles) {
				let relativePath = file.path;
				if (folder.path !== '/') {
					relativePath = file.path.substring(folder.path.length + 1);
				}

				const content = await this.app.vault.read(file);

				allContent.push(`------------\n`);
				allContent.push(`# Document: ${relativePath}\n\n`);
				allContent.push(content);
				allContent.push(`\n\n`);
			}

			const combinedContent = allContent.join('');
			await navigator.clipboard.writeText(combinedContent);
			new Notice(`Copied ${mdFiles.length} combined notes to clipboard!`);
		} catch (e) {
			new Notice(`Error combining notes: ${e.message}`);
		}
	}

	async getMarkdownFiles(folder: TFolder): Promise<TFile[]> {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				files.push(...(await this.getMarkdownFiles(child)));
			} else if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			}
		}
		return files;
	}

	// Preselect the parent folder of the currently active file
	onOpen() {
		super.onOpen();
		
		if (this.plugin.settings.preselectParentFolder) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.parent) {
				// Set the input value to the parent folder path
				this.inputEl.value = activeFile.parent.path;
				// Trigger input event to update the suggestions
				this.inputEl.dispatchEvent(new Event('input'));
			}
		}

		// Add smart backspace functionality
		this.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Backspace' && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
				const input = this.inputEl;
				const cursorPos = input.selectionStart || 0;
				const value = input.value;
				
				// Only do smart delete if cursor is at the end and there's no selection
				if (cursorPos === value.length && input.selectionStart === input.selectionEnd && value.length > 0) {
					evt.preventDefault();
					
					// Check if last character is a slash
					if (value.endsWith('/')) {
						// Just remove the trailing slash
						input.value = value.substring(0, value.length - 1);
					} else {
						// Find the last slash before the cursor
						const lastSlashIndex = value.lastIndexOf('/');
						
						if (lastSlashIndex >= 0) {
							// Delete everything after the last slash, keep the slash
							input.value = value.substring(0, lastSlashIndex + 1);
						} else {
							// If no slash found, clear everything
							input.value = '';
						}
					}
					
					// Trigger input event to update suggestions
					input.dispatchEvent(new Event('input'));
				}
			}
		});
	}
}

class CombineNotesPreviewModal extends Modal {
	folder: TFolder;
	combinedContent: string = '';
	plugin: CombineNotesPlugin;

	constructor(app: App, folder: TFolder, plugin: CombineNotesPlugin) {
		super(app);
		this.folder = folder;
		this.plugin = plugin;
	}

	async onOpen() {
		const {contentEl} = this;
		contentEl.empty();

		try {
			const allContent: string[] = [];
			const mdFiles = await this.getMarkdownFiles(this.folder);

			mdFiles.sort((a, b) => a.path.localeCompare(b.path));

			if (mdFiles.length === 0) {
				contentEl.setText('No markdown files found in that folder.');
				return;
			}

			for (const file of mdFiles) {
				let relativePath = file.path;
				if (this.folder.path !== '/') {
					relativePath = file.path.substring(this.folder.path.length + 1);
				}

				const content = await this.app.vault.read(file);

				allContent.push(`------------\n`);
				allContent.push(`# Document: ${relativePath}\n\n`);
				allContent.push(content);
				allContent.push(`\n\n`);
			}

			this.combinedContent = allContent.join('');

            const button = contentEl.createEl('button', { text: 'Copy to Clipboard' });
			button.addEventListener('click', async () => {
				await navigator.clipboard.writeText(this.combinedContent);
				new Notice('Copied to clipboard!');
			});

			const previewDiv = contentEl.createEl('div', { cls: 'markdown-preview-view' });
			await MarkdownRenderer.render(this.app, this.combinedContent, previewDiv, '', this.plugin);

		} catch (e) {
			contentEl.setText(`Error: ${e.message}`);
		}
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}

	async getMarkdownFiles(folder: TFolder): Promise<TFile[]> {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				files.push(...(await this.getMarkdownFiles(child)));
			} else if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			}
		}
		return files;
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: CombineNotesPlugin;

	constructor(app: App, plugin: CombineNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Combine Notes Plugin'});
		containerEl.createEl('p', {text: 'This plugin allows you to combine multiple notes within a directory into a single note. Use the command palette or right-click on a folder to combine notes.'});

		new Setting(containerEl)
			.setName('Output Folder')
			.setDesc('The folder where combined notes will be saved.')
			.addText(text => text
				.setPlaceholder('Enter output folder path')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Preselect Parent Folder')
			.setDesc('Automatically preselect the parent folder of the currently open file when choosing a folder.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.preselectParentFolder)
				.onChange(async (value) => {
					this.plugin.settings.preselectParentFolder = value;
					await this.plugin.saveSettings();
				}));

		const feedbackEl = containerEl.createEl('p');
		feedbackEl.appendText('Have feedback or want to contribute? ');
		feedbackEl.createEl('a', {href: 'https://github.com/SirBenedick/obsidian-plugin-combine-notes', text: 'Provide feedback on GitHub'});
		feedbackEl.appendText(' or ');
		feedbackEl.createEl('a', {href: 'https://github.com/SirBenedick/obsidian-plugin-combine-notes/pulls', text: 'create a pull request'});
		feedbackEl.appendText('.');
	}
}

